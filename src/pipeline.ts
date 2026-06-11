import { findLatestCheckRun, postCheckRun, postSkippedRun } from './checks.js';
import { listPrCommitMessages } from './commits.js';
import type { AppConfig } from './config.js';
import { buildErrorVerdict, buildVerdictFromOutcomes } from './evaluate.js';
import { extractJiraKeys } from './extract.js';
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

/** The single evaluation path shared by every webhook handler and the poller. */
export async function evaluatePullRequest(
  deps: PipelineDeps,
  pull: PullRef,
  trigger: EvaluationTrigger,
  opts?: { checkHeadSha?: string },
): Promise<void> {
  const { octokit, jira, cfg, scopeCache, log } = deps;
  const startedAt = Date.now();
  // merge_group support: the verdict is computed from the PR but posted on the
  // merge-queue's temporary head SHA.
  const checkSha = opts?.checkHeadSha ?? pull.headSha;
  const checkRef = {
    owner: pull.owner,
    repo: pull.repo,
    headSha: checkSha,
    checkName: cfg.checkName,
  };

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

  let verdict: Verdict;
  let keys: string[] = [];
  // Set only when the Jira-degraded path already read the latest run; reused
  // by the write step so the check-runs endpoint is read at most once.
  let latest: LatestRun | undefined;

  const listing = await listPrCommitMessages(octokit, pull);
  if (!listing.complete) {
    verdict = buildErrorVerdict('too_many_commits', cfg, { totalCommits: listing.totalCommits });
  } else {
    keys = extractJiraKeys(listing.messages, cfg);
    try {
      const outcomes = await jira.getIssueStatuses(keys, deps.jiraCycleCache);
      verdict = buildVerdictFromOutcomes(outcomes, cfg, { commitCount: listing.totalCommits });
    } catch (err) {
      if (err instanceof JiraAuthError) {
        // Config failure, not an outage — never flip org-wide checks over it.
        log.error(
          { evt: 'jira_auth_failed', owner: pull.owner, repo: pull.repo, pr: pull.pullNumber, err: err.message },
          'Jira rejected credentials — skipping check write',
        );
        return;
      }
      if (err instanceof JiraUnavailableError) {
        latest = await findLatestCheckRun(octokit, { ...checkRef, appId: cfg.appId });
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
              head_sha: checkSha,
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
  }

  if (latest === undefined) {
    latest = await findLatestCheckRun(octokit, { ...checkRef, appId: cfg.appId });
  }
  if (latest !== null && latest.externalId === verdict.fingerprint) {
    log.debug(
      { evt: 'check_write', changed: false, owner: pull.owner, repo: pull.repo, pr: pull.pullNumber, head_sha: checkSha },
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
      head_sha: checkSha,
      trigger,
      keys,
      blocking: verdict.issues.filter((i) => i.blocking).map((i) => i.key),
      conclusion: verdict.conclusion,
      duration_ms: Date.now() - startedAt,
    },
    'pull request evaluated',
  );
}
