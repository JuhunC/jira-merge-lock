import type { OctokitLike, Verdict } from './types.js';

export interface CheckRef {
  owner: string;
  repo: string;
  headSha: string;
  checkName: string;
}

/** Latest run of OUR check on a head SHA, or null when none exists. The
 * app_id filter stops a same-named run from another integration (e.g. an
 * Actions job coincidentally called "jira-merge-lock") from confusing dedupe.
 * The prior output (title/summary) is included for callers that need it;
 * old runs may lack output. */
export async function findLatestCheckRun(
  octokit: OctokitLike,
  ref: CheckRef & { appId: number },
): Promise<{
  externalId: string | null;
  conclusion: string | null;
  title: string | null;
  summary: string | null;
} | null> {
  const res = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
    owner: ref.owner,
    repo: ref.repo,
    ref: ref.headSha,
    check_name: ref.checkName,
    app_id: ref.appId,
    filter: 'latest',
    per_page: 1,
  });
  const run = res.data?.check_runs?.[0];
  if (!run) return null;
  return {
    externalId: run.external_id ?? null,
    conclusion: run.conclusion ?? null,
    title: run.output?.title ?? null,
    summary: run.output?.summary ?? null,
  };
}

/** CREATE-ONLY: a same-name run from the same app supersedes the previous one,
 * so no check_run_id bookkeeping and never a PATCH. */
export async function postCheckRun(
  octokit: OctokitLike,
  ref: CheckRef,
  verdict: Verdict,
): Promise<void> {
  await octokit.request('POST /repos/{owner}/{repo}/check-runs', {
    owner: ref.owner,
    repo: ref.repo,
    name: ref.checkName,
    head_sha: ref.headSha,
    status: 'completed',
    conclusion: verdict.conclusion,
    external_id: verdict.fingerprint,
    output: { title: verdict.title, summary: verdict.summary },
  });
}

/** Event-triggered (live) evaluations only: surface progress immediately with
 * an `in_progress` run, then complete it via completeCheckRun. The poller never
 * calls this — an in_progress phase there would churn 2 writes per PR per cycle. */
export async function postInProgressRun(
  octokit: OctokitLike,
  ref: CheckRef & { headSha: string },
): Promise<number> {
  const res = await octokit.request('POST /repos/{owner}/{repo}/check-runs', {
    owner: ref.owner,
    repo: ref.repo,
    name: ref.checkName,
    head_sha: ref.headSha,
    status: 'in_progress',
    output: {
      title: 'Verifying referenced Jira issues…',
      summary:
        "Scanning commit messages for issue keys and checking each issue's status in Jira.",
    },
  });
  return res.data.id;
}

/** Complete a previously posted `in_progress` run (live path only). */
export async function completeCheckRun(
  octokit: OctokitLike,
  ref: CheckRef,
  checkRunId: number,
  completion: { conclusion: string; externalId: string; title: string; summary: string },
): Promise<void> {
  await octokit.request('PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}', {
    owner: ref.owner,
    repo: ref.repo,
    check_run_id: checkRunId,
    status: 'completed',
    conclusion: completion.conclusion,
    external_id: completion.externalId,
    output: { title: completion.title, summary: completion.summary },
  });
}

/** Supersede a stale run on an out-of-scope PR with a `skipped` run. Noop when
 * we never touched the SHA (no run) or it is already skipped — never create
 * noise on PRs we were never required on. */
export async function postSkippedRun(
  octokit: OctokitLike,
  ref: CheckRef & { appId: number },
  reason: string,
  configHash: string,
): Promise<'posted' | 'noop'> {
  const latest = await findLatestCheckRun(octokit, ref);
  if (latest === null || latest.conclusion === 'skipped') return 'noop';

  await octokit.request('POST /repos/{owner}/{repo}/check-runs', {
    owner: ref.owner,
    repo: ref.repo,
    name: ref.checkName,
    head_sha: ref.headSha,
    status: 'completed',
    conclusion: 'skipped',
    external_id: `skipped|${configHash}`,
    output: { title: 'Not in scope', summary: reason },
  });
  return 'posted';
}
