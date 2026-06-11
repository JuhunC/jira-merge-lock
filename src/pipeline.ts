import {
  completeCheckRun,
  findLatestCheckRun,
  postCheckRun,
  postInProgressRun,
  postSkippedRun,
} from './checks.js';
import { listPrCommitMessages } from './commits.js';
import { buildErrorVerdict, buildVerdictFromOutcomes } from './evaluate.js';
import { extractJiraKeys } from './extract.js';
import type { AppConfig } from './config.js';
import type { JiraClient } from './jira.js';
import { isInScope, type ScopeCache } from './rulesets.js';
import { JiraAuthError, JiraUnavailableError } from './types.js';
import type {
  EvaluationTrigger,
  JiraCycleCache,
  LoggerLike,
  OctokitLike,
  PullRef,
  Verdict,
} from './types.js';

export interface PipelineDeps {
  octokit: OctokitLike;
  jira: JiraClient;
  cfg: AppConfig;
  scopeCache: ScopeCache;
  jiraCycleCache?: JiraCycleCache;
  log: LoggerLike;
}

type LatestRun = Awaited<ReturnType<typeof findLatestCheckRun>>;

interface CheckRefWithSha {
  owner: string;
  repo: string;
  headSha: string;
  checkName: string;
}

/** Body of the completing PATCH on the live (event-triggered) path. */
interface Completion {
  conclusion: string;
  externalId: string;
  title: string;
  summary: string;
}

const OUTAGE_NOTE =
  '_Jira could not be consulted during this re-check — showing the last verified result._';

function completionFromVerdict(verdict: Verdict): Completion {
  return {
    conclusion: verdict.conclusion,
    externalId: verdict.fingerprint,
    title: verdict.title,
    summary: verdict.summary,
  };
}

interface PriorVerdict {
  externalId: string | null;
  conclusion: 'success' | 'failure';
  title: string | null;
  summary: string | null;
}

/** Only a prior run that concluded success|failure is a real verdict. A
 * `skipped` run is a scope marker — GitHub treats skipped as satisfying a
 * required check, so replicating it during an outage would let a newly
 * in-scope, never-verified SHA merge. Treat it (and anything else) as "no
 * verdict": fail closed instead. */
function priorVerdictOf(latest: LatestRun): PriorVerdict | null {
  if (latest === null) return null;
  if (latest.conclusion !== 'success' && latest.conclusion !== 'failure') return null;
  return { ...latest, conclusion: latest.conclusion };
}

/** Invariant-3 replication: complete the in_progress run with the prior run's
 * verdict, appending an outage note. Reusing the prior external_id keeps
 * future fingerprint dedupe working once Jira heals. */
function replicatedCompletion(prior: PriorVerdict): Completion {
  return {
    conclusion: prior.conclusion,
    externalId: prior.externalId ?? '',
    title: prior.title ?? 'Last verified result',
    summary: prior.summary ? `${prior.summary}\n\n${OUTAGE_NOTE}` : OUTAGE_NOTE,
  };
}

/** commits → keys → Jira → verdict. Throws JiraUnavailableError / JiraAuthError
 * upward — the caller applies the path-specific (live vs poll) policy. */
async function computeVerdict(
  deps: PipelineDeps,
  pull: PullRef,
): Promise<{ verdict: Verdict; keys: string[] }> {
  const listing = await listPrCommitMessages(deps.octokit, pull);
  if (!listing.complete) {
    return {
      verdict: buildErrorVerdict('too_many_commits', deps.cfg, {
        totalCommits: listing.totalCommits,
      }),
      keys: [],
    };
  }
  const keys = extractJiraKeys(listing.messages, deps.cfg);
  const outcomes = await deps.jira.getIssueStatuses(keys, deps.jiraCycleCache);
  return {
    verdict: buildVerdictFromOutcomes(outcomes, deps.cfg, { commitCount: listing.totalCommits }),
    keys,
  };
}

/** The single evaluation path shared by every webhook handler and the poller.
 *
 * Two completion styles, one policy core:
 *  - live (any trigger except 'poll'): an `in_progress` run is posted
 *    immediately, then completed (PATCH) with the verdict — no exit path may
 *    strand it (that would block the PR as eternally pending).
 *  - poll: silent create-only writes with fingerprint dedupe — near-zero
 *    steady-state writes, never an in_progress phase.
 */
export async function evaluatePullRequest(
  deps: PipelineDeps,
  pull: PullRef,
  trigger: EvaluationTrigger,
  opts?: { checkHeadSha?: string },
): Promise<void> {
  const { octokit, cfg, scopeCache, log } = deps;
  const startedAt = Date.now();
  // merge_group support: the verdict is computed from the PR but posted on the
  // merge-queue's temporary head SHA.
  const checkSha = opts?.checkHeadSha ?? pull.headSha;
  const checkRef: CheckRefWithSha = {
    owner: pull.owner,
    repo: pull.repo,
    headSha: checkSha,
    checkName: cfg.checkName,
  };

  // Scope gate runs BEFORE any write — out-of-scope PRs never get an
  // in_progress run.
  const inScope = await isInScope(
    octokit,
    { owner: pull.owner, repo: pull.repo, branch: pull.baseRef },
    cfg,
    scopeCache,
    log,
  );
  if (!inScope) {
    await postSkippedRun(
      octokit,
      { ...checkRef, appId: cfg.appId },
      `Branch \`${pull.baseRef}\` is not covered by any active \`${cfg.rulesetNamePrefix}*\` ruleset requiring this check.`,
      cfg.configHash,
    );
    return;
  }

  // Single up-front read — both paths use it (poll: fingerprint dedupe; live:
  // outage/auth replication), keeping the at-most-one-read property. Must
  // happen BEFORE the live in_progress POST, which would otherwise become the
  // "latest" run itself and hide the prior verdict.
  const latest = await findLatestCheckRun(octokit, { ...checkRef, appId: cfg.appId });

  if (trigger !== 'poll') {
    await evaluateLive(deps, pull, trigger, checkRef, latest, startedAt);
    return;
  }
  await evaluatePoll(deps, pull, checkRef, latest, startedAt);
}

/** Live path: in_progress immediately, completed (PATCH) after the Jira
 * lookup. Every code path after the in_progress POST completes the run. */
async function evaluateLive(
  deps: PipelineDeps,
  pull: PullRef,
  trigger: EvaluationTrigger,
  checkRef: CheckRefWithSha,
  latest: LatestRun,
  startedAt: number,
): Promise<void> {
  const { octokit, cfg, log } = deps;
  const checkRunId = await postInProgressRun(octokit, checkRef);

  let completion: Completion;
  let keys: string[] = [];
  let blocking: string[] = [];
  try {
    try {
      const result = await computeVerdict(deps, pull);
      keys = result.keys;
      blocking = result.verdict.issues.filter((i) => i.blocking).map((i) => i.key);
      completion = completionFromVerdict(result.verdict);
    } catch (err) {
      const prior = priorVerdictOf(latest);
      if (err instanceof JiraUnavailableError) {
        if (prior !== null) {
          log.info(
            {
              evt: 'jira_degraded',
              action: 'replicated_last_verdict',
              owner: pull.owner,
              repo: pull.repo,
              pr: pull.pullNumber,
              head_sha: checkRef.headSha,
              kind: err.kind,
            },
            'Jira unavailable — replicating the last verdict on this SHA',
          );
          completion = replicatedCompletion(prior);
        } else {
          completion = completionFromVerdict(buildErrorVerdict('jira_unreachable', cfg));
        }
      } else if (err instanceof JiraAuthError) {
        // Config failure, not an outage — but the in_progress run must still
        // be completed, so (unlike the poll path) we cannot simply not write.
        log.error(
          {
            evt: 'jira_auth_failed',
            owner: pull.owner,
            repo: pull.repo,
            pr: pull.pullNumber,
            err: err.message,
          },
          'Jira rejected credentials — completing the check from the last verdict or fail-closed',
        );
        completion =
          prior !== null
            ? replicatedCompletion(prior)
            : completionFromVerdict(buildErrorVerdict('jira_auth_failed', cfg));
      } else {
        throw err;
      }
    }
    await completeCheckRun(octokit, checkRef, checkRunId, completion);
  } catch (err) {
    // No exit path may strand the run at in_progress (a required check stuck
    // pending blocks the PR forever): complete as failure, then rethrow.
    try {
      await completeCheckRun(octokit, checkRef, checkRunId, {
        conclusion: 'failure',
        externalId: `internal_error|${cfg.configHash}`,
        title: 'jira-merge-lock internal error — use Re-run',
        summary:
          'The evaluation crashed before a verdict could be computed. The check is completed as a failure so this pull request is not left pending forever.\n\nUse "Re-run" on this check to retry (or wait for the automatic re-check); see the app logs for the underlying error.',
      });
    } catch (completeErr) {
      log.error(
        {
          evt: 'check_complete_failed',
          owner: pull.owner,
          repo: pull.repo,
          pr: pull.pullNumber,
          head_sha: checkRef.headSha,
          err: completeErr instanceof Error ? completeErr.message : String(completeErr),
        },
        'failed to complete the in_progress run after an internal error',
      );
    }
    throw err;
  }

  log.info(
    {
      evt: 'verdict',
      phase: 'completed',
      owner: pull.owner,
      repo: pull.repo,
      pr: pull.pullNumber,
      head_sha: checkRef.headSha,
      trigger,
      keys,
      blocking,
      conclusion: completion.conclusion,
      duration_ms: Date.now() - startedAt,
    },
    'pull request evaluated',
  );
}

/** Poll path: exactly the historical silent behavior — fingerprint dedupe,
 * create-only completed POSTs, keep-last-verdict (no write) on Jira outage,
 * no write on Jira auth failure. */
async function evaluatePoll(
  deps: PipelineDeps,
  pull: PullRef,
  checkRef: CheckRefWithSha,
  latest: LatestRun,
  startedAt: number,
): Promise<void> {
  const { octokit, cfg, log } = deps;

  let verdict: Verdict;
  let keys: string[] = [];
  try {
    ({ verdict, keys } = await computeVerdict(deps, pull));
  } catch (err) {
    if (err instanceof JiraAuthError) {
      // Config failure, not an outage — never flip org-wide checks over it.
      log.error(
        {
          evt: 'jira_auth_failed',
          owner: pull.owner,
          repo: pull.repo,
          pr: pull.pullNumber,
          err: err.message,
        },
        'Jira rejected credentials — skipping check write',
      );
      return;
    }
    if (err instanceof JiraUnavailableError) {
      // A `skipped` run is a scope marker, not a verdict — GitHub treats
      // skipped as satisfying a required check, so keeping it would let a
      // newly in-scope, never-verified SHA merge for the whole outage.
      // Treat it like "no run": fail closed below.
      if (latest !== null && latest.conclusion !== 'skipped') {
        log.info(
          {
            evt: 'jira_degraded',
            action: 'kept_last_verdict',
            owner: pull.owner,
            repo: pull.repo,
            pr: pull.pullNumber,
            head_sha: checkRef.headSha,
            kind: err.kind,
          },
          'Jira unavailable — keeping last verdict on this SHA',
        );
        return;
      }
      verdict = buildErrorVerdict('jira_unreachable', cfg);
    } else {
      throw err;
    }
  }

  if (latest !== null && latest.externalId === verdict.fingerprint) {
    log.debug(
      {
        evt: 'check_write',
        changed: false,
        owner: pull.owner,
        repo: pull.repo,
        pr: pull.pullNumber,
        head_sha: checkRef.headSha,
      },
      'fingerprint unchanged — skipping check write',
    );
  } else {
    await postCheckRun(octokit, checkRef, verdict);
  }

  log.info(
    {
      evt: 'verdict',
      owner: pull.owner,
      repo: pull.repo,
      pr: pull.pullNumber,
      head_sha: checkRef.headSha,
      trigger: 'poll',
      keys,
      blocking: verdict.issues.filter((i) => i.blocking).map((i) => i.key),
      conclusion: verdict.conclusion,
      duration_ms: Date.now() - startedAt,
    },
    'pull request evaluated',
  );
}
