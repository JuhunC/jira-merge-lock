import type { OctokitLike, Verdict } from './types.js';

export interface CheckRef {
  owner: string;
  repo: string;
  headSha: string;
  checkName: string;
}

/** Latest run of OUR check on a head SHA, or null when none exists. The
 * app_id filter stops a same-named run from another integration (e.g. an
 * Actions job coincidentally called "jira-merge-lock") from confusing dedupe. */
export async function findLatestCheckRun(
  octokit: OctokitLike,
  ref: CheckRef & { appId: number },
): Promise<{ externalId: string | null; conclusion: string | null } | null> {
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
  return { externalId: run.external_id ?? null, conclusion: run.conclusion ?? null };
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
