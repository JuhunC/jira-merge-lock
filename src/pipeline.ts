import {
  completeCheckRun,
  findLatestCheckRun,
  postCheckRun,
  postInProgressRun,
  postSkippedRun,
} from './checks.js';
import { buildCommentVerdict, countNonAuthorComments } from './comments.js';
import { listPrCommitMessages } from './commits.js';
import { buildErrorVerdict, buildVerdictFromOutcomes } from './evaluate.js';
import { extractJiraKeys } from './extract.js';
import type { AppConfig } from './config.js';
import type { JiraClient } from './jira.js';
import { isInScope, type ScopeCache } from './rulesets.js';
import type { StatusTracker } from './status.js';
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
  /** Optional sink for /status — evaluation outcomes and blocked-PR state. */
  status?: StatusTracker;
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

function completionFromVerdict(verdict: Verdict): Completion {
  return {
    conclusion: verdict.conclusion,
    externalId: verdict.fingerprint,
    title: verdict.title,
    summary: verdict.summary,
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
    // "Webhook arrived, nothing happened" must be explainable from the logs:
    // event-triggered out-of-scope decisions log at info. The poll path logs
    // at debug — it re-visits every open PR each cycle and would spam.
    const logFn = trigger === 'poll' ? log.debug.bind(log) : log.info.bind(log);
    logFn(
      {
        evt: 'out_of_scope',
        owner: pull.owner,
        repo: pull.repo,
        pr: pull.pullNumber,
        base: pull.baseRef,
        trigger,
        prefix: cfg.rulesetNamePrefix,
      },
      `PR out of scope — no active ruleset requires "${cfg.checkName}" on base branch "${pull.baseRef}"`,
    );
    deps.status?.recordSkipped({ ...pull, check: cfg.checkName });
    await postSkippedRun(
      octokit,
      { ...checkRef, appId: cfg.appId },
      `Branch \`${pull.baseRef}\` is not covered by any active \`${cfg.rulesetNamePrefix}*\` ruleset requiring this check.`,
      cfg.configHash,
    );
    return;
  }

  // Single up-front read, before any write — the poll path uses it for
  // fingerprint dedupe. Error verdicts have stable fingerprints, so an
  // extended Jira outage writes each PR's failure ONCE and every subsequent
  // poll cycle skips the write.
  const latest = await findLatestCheckRun(octokit, { ...checkRef, appId: cfg.appId });

  if (trigger !== 'poll') {
    await evaluateLive(deps, pull, trigger, checkRef, startedAt);
    return;
  }
  await evaluatePoll(deps, pull, checkRef, latest, startedAt);
}

/** Live path: in_progress immediately, completed (PATCH) after the Jira
 * lookup. Every code path after the in_progress POST completes the run.
 * When Jira cannot be consulted (outage or credential failure) the run is
 * completed as a FAILURE with an explanatory verdict — "Jira down" is always
 * visibly blocking; prior verdicts are never kept or replicated. */
async function evaluateLive(
  deps: PipelineDeps,
  pull: PullRef,
  trigger: EvaluationTrigger,
  checkRef: CheckRefWithSha,
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
      if (err instanceof JiraUnavailableError) {
        log.info(
          {
            evt: 'jira_degraded',
            action: 'fail_closed',
            owner: pull.owner,
            repo: pull.repo,
            pr: pull.pullNumber,
            head_sha: checkRef.headSha,
            kind: err.kind,
          },
          'Jira unavailable — completing the check as the fail-closed failure',
        );
        completion = completionFromVerdict(buildErrorVerdict('jira_unreachable', cfg));
      } else if (err instanceof JiraAuthError) {
        // Config failure, not an outage — still fails the check, with a
        // verdict that points the operator at the JIRA_* configuration.
        log.error(
          {
            evt: 'jira_auth_failed',
            owner: pull.owner,
            repo: pull.repo,
            pr: pull.pullNumber,
            err: err.message,
          },
          'Jira rejected credentials — completing the check as the auth-failure verdict',
        );
        completion = completionFromVerdict(buildErrorVerdict('jira_auth_failed', cfg));
      } else {
        throw err;
      }
    }
    await completeCheckRun(octokit, checkRef, checkRunId, completion);
    deps.status?.recordEvaluation({
      owner: pull.owner,
      repo: pull.repo,
      pullNumber: pull.pullNumber,
      check: cfg.checkName,
      trigger,
      conclusion: completion.conclusion as 'success' | 'failure',
      title: completion.title,
    });
  } catch (err) {
    // No exit path may strand the run at in_progress (a required check stuck
    // pending blocks the PR forever): complete as failure, then rethrow.
    try {
      await completeCheckRun(octokit, checkRef, checkRunId, {
        conclusion: 'failure',
        externalId: `internal_error|${cfg.configHash}`,
        title: 'merge-lock internal error — use Re-run',
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

/** Combined entry point for callers that own a whole PR evaluation (webhook
 * pull_request events, rerequested suites, merge groups, the poller): the
 * Jira check always, plus the comment check when MIN_PR_COMMENTS > 0.
 * Sequential on purpose — a thrown Jira-check error (e.g. GitHub API failure)
 * skips the comment check; the caller's retry policy re-runs both. */
export async function evaluateAllChecks(
  deps: PipelineDeps,
  pull: PullRef,
  trigger: EvaluationTrigger,
  opts?: { checkHeadSha?: string },
): Promise<void> {
  await evaluatePullRequest(deps, pull, trigger, opts);
  if (deps.cfg.minPrComments > 0) {
    await evaluateCommentCheck(deps, pull, trigger, opts);
  }
}

/** The discussion gate (MIN_PR_COMMENTS): a second, independent check run.
 * Mirrors evaluatePullRequest's two completion styles — live posts an
 * in_progress run and completes it (never stranding it), poll does silent
 * create-only writes with fingerprint dedupe. Scope is the same gate as the
 * Jira check: both contexts are injected into prefix rulesets together. */
export async function evaluateCommentCheck(
  deps: PipelineDeps,
  pull: PullRef,
  trigger: EvaluationTrigger,
  opts?: { checkHeadSha?: string },
): Promise<void> {
  const { octokit, cfg, scopeCache, log } = deps;
  const startedAt = Date.now();
  const checkRef: CheckRefWithSha = {
    owner: pull.owner,
    repo: pull.repo,
    headSha: opts?.checkHeadSha ?? pull.headSha,
    checkName: cfg.commentCheckName,
  };

  const inScope = await isInScope(
    octokit,
    { owner: pull.owner, repo: pull.repo, branch: pull.baseRef },
    cfg,
    scopeCache,
    log,
  );
  if (!inScope) {
    const logFn = trigger === 'poll' ? log.debug.bind(log) : log.info.bind(log);
    logFn(
      {
        evt: 'out_of_scope',
        check: cfg.commentCheckName,
        owner: pull.owner,
        repo: pull.repo,
        pr: pull.pullNumber,
        base: pull.baseRef,
        trigger,
        prefix: cfg.rulesetNamePrefix,
      },
      `PR out of scope — no active ruleset requires "${cfg.checkName}" on base branch "${pull.baseRef}"`,
    );
    deps.status?.recordSkipped({ ...pull, check: cfg.commentCheckName });
    await postSkippedRun(
      octokit,
      { ...checkRef, appId: cfg.appId },
      `Branch \`${pull.baseRef}\` is not covered by any active \`${cfg.rulesetNamePrefix}*\` ruleset requiring this check.`,
      cfg.configHash,
    );
    return;
  }

  const latest = await findLatestCheckRun(octokit, { ...checkRef, appId: cfg.appId });

  let checkRunId: number | undefined;
  if (trigger !== 'poll') {
    checkRunId = await postInProgressRun(octokit, checkRef, {
      title: 'Counting comments from reviewers…',
      summary: `Verifying that this pull request has at least ${cfg.minPrComments} comment(s) from someone other than its author.`,
    });
  }

  let verdict: Verdict;
  try {
    const { count } = await countNonAuthorComments(octokit, pull, cfg.minPrComments);
    verdict = buildCommentVerdict(count, cfg);
  } catch (err) {
    // Same invariant as the Jira check: a posted in_progress run is never
    // stranded — complete as failure, then rethrow for the caller's policy.
    if (checkRunId !== undefined) {
      try {
        await completeCheckRun(octokit, checkRef, checkRunId, {
          conclusion: 'failure',
          externalId: `internal_error|${cfg.configHash}`,
          title: `${cfg.commentCheckName} internal error — use Re-run`,
          summary:
            'The comment count could not be computed. The check is completed as a failure so this pull request is not left pending forever.\n\nUse "Re-run" on this check to retry (or wait for the automatic re-check); see the app logs for the underlying error.',
        });
      } catch (completeErr) {
        log.error(
          {
            evt: 'check_complete_failed',
            check: cfg.commentCheckName,
            owner: pull.owner,
            repo: pull.repo,
            pr: pull.pullNumber,
            head_sha: checkRef.headSha,
            err: completeErr instanceof Error ? completeErr.message : String(completeErr),
          },
          'failed to complete the in_progress comment-check run after an internal error',
        );
      }
    }
    throw err;
  }

  const changed = !(latest !== null && latest.externalId === verdict.fingerprint);
  if (checkRunId !== undefined) {
    await completeCheckRun(octokit, checkRef, checkRunId, completionFromVerdict(verdict));
  } else if (!changed) {
    log.debug(
      {
        evt: 'check_write',
        check: cfg.commentCheckName,
        changed: false,
        owner: pull.owner,
        repo: pull.repo,
        pr: pull.pullNumber,
        head_sha: checkRef.headSha,
      },
      'fingerprint unchanged — skipping comment-check write',
    );
  } else {
    await postCheckRun(octokit, checkRef, verdict);
  }
  deps.status?.recordEvaluation(
    {
      owner: pull.owner,
      repo: pull.repo,
      pullNumber: pull.pullNumber,
      check: cfg.commentCheckName,
      trigger,
      conclusion: verdict.conclusion,
      title: verdict.title,
    },
    // Live runs always feed; silent poll confirmations only refresh the map.
    { feed: trigger !== 'poll' || changed },
  );

  log.info(
    {
      evt: 'comment_verdict',
      owner: pull.owner,
      repo: pull.repo,
      pr: pull.pullNumber,
      head_sha: checkRef.headSha,
      trigger,
      min_required: cfg.minPrComments,
      conclusion: verdict.conclusion,
      duration_ms: Date.now() - startedAt,
    },
    'comment requirement evaluated',
  );
}

/** Poll path: silent create-only completed POSTs with fingerprint dedupe.
 * When Jira cannot be consulted (outage or credential failure) the
 * corresponding fail-closed error verdict is POSTED — no keep-last-verdict.
 * Error verdicts have stable fingerprints, so the dedupe below caps an
 * extended outage at one write per PR (a completed POST also supersedes any
 * stranded in_progress run on the SHA). */
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
      // Config failure, not an outage — fails the check all the same, with a
      // verdict that points the operator at the JIRA_* configuration.
      log.error(
        {
          evt: 'jira_auth_failed',
          owner: pull.owner,
          repo: pull.repo,
          pr: pull.pullNumber,
          err: err.message,
        },
        'Jira rejected credentials — posting the auth-failure verdict',
      );
      verdict = buildErrorVerdict('jira_auth_failed', cfg);
    } else if (err instanceof JiraUnavailableError) {
      log.info(
        {
          evt: 'jira_degraded',
          action: 'fail_closed',
          owner: pull.owner,
          repo: pull.repo,
          pr: pull.pullNumber,
          head_sha: checkRef.headSha,
          kind: err.kind,
        },
        'Jira unavailable — posting the fail-closed failure verdict',
      );
      verdict = buildErrorVerdict('jira_unreachable', cfg);
    } else {
      throw err;
    }
  }

  const changed = !(latest !== null && latest.externalId === verdict.fingerprint);
  if (!changed) {
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
  // Unchanged verdicts refresh the blocked-PR map silently (feed: false) —
  // the /status activity feed shows changes, not every PR every cycle.
  deps.status?.recordEvaluation(
    {
      owner: pull.owner,
      repo: pull.repo,
      pullNumber: pull.pullNumber,
      check: cfg.checkName,
      trigger: 'poll',
      conclusion: verdict.conclusion,
      title: verdict.title,
    },
    { feed: changed },
  );

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
