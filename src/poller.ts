import type { AppConfig } from './config.js';
import type { JiraClient } from './jira.js';
import { evaluateAllChecks } from './pipeline.js';
import {
  autoconfigureOrg,
  discoverPrefixRulesets,
  repoCouldMatch,
  type ScopeCache,
} from './rulesets.js';
import type { StatusTracker } from './status.js';
import type { JiraCycleCache, LoggerLike, OctokitLike, PullRef } from './types.js';

export interface PollerDeps {
  auth: (installationId?: number) => Promise<any>;
  cfg: AppConfig;
  jira: JiraClient;
  scopeCache: ScopeCache;
  log: LoggerLike;
  /** Optional sink for /status — records cycle outcomes and coverage counters. */
  status?: StatusTracker;
}

export interface Poller {
  start(): void;
  stop(): void;
  runOnce(): Promise<void>;
  pollInstallation(installationId: number): void;
}

interface InstallationLike {
  id: number;
  account?: { login?: string; type?: string } | null;
  repository_selection?: string;
}

interface RepoLike {
  id: number;
  name: string;
  owner?: { login?: string } | null;
}

interface CycleCounters {
  installations: number;
  rulesets: number;
  repos_scanned: number;
  repos_pruned: number;
  prs: number;
}

// Once per process, not per poller instance.
const warnedNonOrgInstallations = new Set<number>();
const warnedSelectedInstallations = new Set<number>();

function isRepoLike(value: unknown): value is RepoLike {
  const repo = value as RepoLike | null;
  return typeof repo?.id === 'number' && typeof repo?.name === 'string';
}

/** GET /installation/repositories returns {repositories:[...]} envelopes.
 * octokit.paginate usually flattens them, but structural fakes (and a
 * misbehaving normalization) won't — accept both shapes. */
function flattenRepoItems(items: unknown[]): RepoLike[] {
  const repos: RepoLike[] = [];
  for (const item of items) {
    const envelope = item as { repositories?: unknown } | null;
    if (Array.isArray(envelope?.repositories)) {
      for (const repo of envelope.repositories) {
        if (isRepoLike(repo)) repos.push(repo);
      }
    } else if (isRepoLike(item)) {
      repos.push(item);
    }
  }
  return repos;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Drains every item even if some callbacks reject: callers are expected to
 * catch and log inside `fn` (one bad repo must not starve the rest). */
async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

export function createPoller(deps: PollerDeps): Poller {
  const { cfg, log } = deps;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const isOrgInstallation = (installation: InstallationLike): boolean => {
    if (installation.account?.type === 'Organization') return true;
    if (!warnedNonOrgInstallations.has(installation.id)) {
      warnedNonOrgInstallations.add(installation.id);
      log.warn(
        {
          evt: 'poll_skip_non_org_installation',
          installation_id: installation.id,
          account: installation.account?.login,
        },
        'installation is not on an organization — org rulesets cannot exist there; skipping',
      );
    }
    return false;
  };

  const pollInstallationBody = async (
    installation: InstallationLike,
    jiraCycleCache: JiraCycleCache,
    counters: CycleCounters,
  ): Promise<void> => {
    const org = installation.account?.login;
    if (!org) throw new Error(`installation ${installation.id} has no account login`);
    const octokit = (await deps.auth(installation.id)) as OctokitLike;

    if (
      installation.repository_selection === 'selected' &&
      !warnedSelectedInstallations.has(installation.id)
    ) {
      warnedSelectedInstallations.add(installation.id);
      log.warn(
        {
          evt: 'installation_coverage_warning',
          installation_id: installation.id,
          org,
          repository_selection: 'selected',
        },
        'app is installed on SELECTED repositories only — any prefix ruleset targeting an uncovered repo will require a check no one can post, leaving those PRs permanently unmergeable. Install on All repositories.',
      );
    }

    await autoconfigureOrg(octokit, org, cfg, log);

    const repoItems = await octokit.paginate('GET /installation/repositories', { per_page: 100 });
    const repos = flattenRepoItems(repoItems);
    // Heuristic pruning only — survivors still pass the authoritative
    // branch-rules gate inside the pipeline.
    const prefixRulesets = await discoverPrefixRulesets(octokit, org, cfg, log);
    counters.rulesets += prefixRulesets.length;
    const surviving = repos.filter((repo) => repoCouldMatch(prefixRulesets, repo));
    counters.repos_pruned += repos.length - surviving.length;

    await forEachWithConcurrency(surviving, cfg.pollConcurrency, async (repo) => {
      const owner = repo.owner?.login ?? org;
      let prs: unknown[];
      try {
        prs = await octokit.paginate('GET /repos/{owner}/{repo}/pulls', {
          owner,
          repo: repo.name,
          state: 'open',
          per_page: 100,
        });
      } catch (err) {
        // One 403/451/5xx repo must not starve the rest of the org's repos.
        log.error(
          {
            evt: 'poll_repo_failed',
            installation_id: installation.id,
            owner,
            repo: repo.name,
            err: errMessage(err),
          },
          'failed to list open PRs — continuing with the next repo',
        );
        return;
      }
      counters.repos_scanned += 1;
      for (const item of prs) {
        const pr = item as {
          number: number;
          head: { sha: string };
          base: { ref: string; sha: string };
          user?: { login?: string } | null;
        };
        counters.prs += 1;
        const pull: PullRef = {
          owner,
          repo: repo.name,
          pullNumber: pr.number,
          headSha: pr.head.sha,
          baseRef: pr.base.ref,
          baseSha: pr.base.sha,
          authorLogin: pr.user?.login,
        };
        try {
          await evaluateAllChecks(
            { octokit, jira: deps.jira, cfg, scopeCache: deps.scopeCache, jiraCycleCache, log },
            pull,
            'poll',
          );
        } catch (err) {
          // One failing PR must not abort the remaining PRs/repos of the cycle.
          log.error(
            {
              evt: 'poll_pr_failed',
              owner,
              repo: repo.name,
              pull_number: pr.number,
              head_sha: pr.head.sha,
              err: errMessage(err),
            },
            'PR evaluation failed — continuing with the next PR',
          );
        }
      }
    });
  };

  const cycle = async (): Promise<{ counters: CycleCounters; durationMs: number; jiraFetches: number }> => {
    const startedAt = Date.now();
    const counters: CycleCounters = {
      installations: 0,
      rulesets: 0,
      repos_scanned: 0,
      repos_pruned: 0,
      prs: 0,
    };
    const jiraCycleCache: JiraCycleCache = new Map();

    const appOctokit = (await deps.auth()) as OctokitLike;
    const installations = await appOctokit.paginate('GET /app/installations', { per_page: 100 });
    for (const item of installations) {
      const installation = item as InstallationLike;
      if (!isOrgInstallation(installation)) continue;
      counters.installations += 1;
      try {
        await pollInstallationBody(installation, jiraCycleCache, counters);
      } catch (err) {
        log.error(
          {
            evt: 'poll_installation_failed',
            installation_id: installation.id,
            org: installation.account?.login,
            err: errMessage(err),
          },
          'installation poll failed — continuing with the next installation',
        );
      }
    }

    const durationMs = Date.now() - startedAt;
    // jiraCycleCache holds one entry per distinct key fetched this cycle, so
    // its size IS the number of real Jira consultations.
    log.info(
      { evt: 'poll_done', ...counters, jira_fetches: jiraCycleCache.size, duration_ms: durationMs },
      'poll cycle complete',
    );
    const intervalMs = cfg.pollIntervalSeconds * 1000;
    if (intervalMs > 0 && durationMs > intervalMs) {
      log.warn(
        { evt: 'poll_overrun', duration_ms: durationMs, interval_ms: intervalMs },
        'poll cycle took longer than the poll interval — consider raising POLL_INTERVAL_SECONDS',
      );
    }
    return { counters, durationMs, jiraFetches: jiraCycleCache.size };
  };

  const runOnce = async (): Promise<void> => {
    if (busy) {
      log.info({ evt: 'poll_skipped' }, 'previous poll cycle still running — skipping this one');
      return;
    }
    busy = true;
    // Watchdog: a cycle that never finishes (e.g. a hung connection) would
    // otherwise be invisible — no poll_done, no poll_cycle_failed, only
    // poll_skipped ticks. Warn every 5 minutes while a cycle is stuck.
    const startedAt = Date.now();
    const watchdog = setInterval(() => {
      log.warn(
        { evt: 'poll_stuck', running_ms: Date.now() - startedAt },
        'poll cycle has been running for an unusually long time — a GitHub or Jira call may be hung',
      );
    }, 300_000);
    watchdog.unref();
    deps.status?.recordPollStarted();
    try {
      const { counters, durationMs, jiraFetches } = await cycle();
      deps.status?.recordPollCompleted({ ...counters, jira_fetches: jiraFetches }, durationMs);
    } catch (err) {
      log.error({ evt: 'poll_cycle_failed', err: errMessage(err) }, 'poll cycle failed unexpectedly');
      // /status is public — the category is fixed; err detail stays in the log.
      deps.status?.recordPollFailed('poll cycle failed — see server logs');
    } finally {
      clearInterval(watchdog);
      busy = false;
    }
  };

  const scheduleNext = (): void => {
    const baseMs = cfg.pollIntervalSeconds * 1000;
    const jitteredMs = Math.round(baseMs * (0.9 + Math.random() * 0.2));
    timer = setTimeout(() => {
      scheduleNext();
      void runOnce();
    }, jitteredMs);
    timer.unref();
  };

  return {
    start(): void {
      if (timer) return;
      void runOnce();
      if (cfg.pollIntervalSeconds > 0) scheduleNext();
    },

    stop(): void {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },

    runOnce,

    pollInstallation(installationId: number): void {
      if (busy) {
        log.debug(
          { evt: 'poll_installation_skipped', installation_id: installationId },
          'a poll cycle is already running — skipping one-off installation poll',
        );
        return;
      }
      busy = true;
      void (async () => {
        const startedAt = Date.now();
        const counters: CycleCounters = {
          installations: 1,
          rulesets: 0,
          repos_scanned: 0,
          repos_pruned: 0,
          prs: 0,
        };
        try {
          const appOctokit = (await deps.auth()) as OctokitLike;
          const res = await appOctokit.request('GET /app/installations/{installation_id}', {
            installation_id: installationId,
          });
          const installation = res.data as InstallationLike;
          if (!isOrgInstallation(installation)) return;
          await pollInstallationBody(installation, new Map(), counters);
          log.info(
            {
              evt: 'poll_installation_done',
              installation_id: installationId,
              repos_scanned: counters.repos_scanned,
              repos_pruned: counters.repos_pruned,
              prs: counters.prs,
              duration_ms: Date.now() - startedAt,
            },
            'one-off installation poll complete',
          );
        } catch (err) {
          log.error(
            { evt: 'poll_installation_failed', installation_id: installationId, err: errMessage(err) },
            'one-off installation poll failed',
          );
        } finally {
          busy = false;
        }
      })();
    },
  };
}
