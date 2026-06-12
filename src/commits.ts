import type { CommitListing, OctokitLike, PullRef } from './types.js';

/** Hard cap of GET /pulls/{n}/commits — hitting it is the ONLY reliable
 * truncation signal (pulls.list items carry no commits field). */
const PR_COMMITS_CAP = 250;

/** Octokit's paginate does not unwrap the compare route (its page body keeps
 * a `url` key, which defeats the plugin's normalization), so each "item" is a
 * whole page object holding a `commits` array. Normalize defensively: accept
 * either page objects or already-flattened commit objects. */
function flattenCompareItems(items: unknown[]): Array<{ sha?: unknown; commit: { message: string } }> {
  const commits: Array<{ sha?: unknown; commit: { message: string } }> = [];
  for (const item of items) {
    const it = item as { commits?: unknown; commit?: unknown };
    if (it && Array.isArray(it.commits)) {
      for (const c of it.commits) {
        if (c && typeof (c as { commit?: { message?: unknown } }).commit?.message === 'string') {
          commits.push(c as { sha?: unknown; commit: { message: string } });
        }
      }
    } else if (it && typeof (it.commit as { message?: unknown } | undefined)?.message === 'string') {
      commits.push(it as { sha?: unknown; commit: { message: string } });
    }
  }
  return commits;
}

function toEntry(c: { sha?: unknown; commit: { message: string } }): { sha: string | null; message: string } {
  return { sha: typeof c.sha === 'string' ? c.sha : null, message: c.commit.message };
}

export async function listPrCommitMessages(
  octokit: OctokitLike,
  pull: PullRef,
): Promise<CommitListing> {
  const { owner, repo, pullNumber } = pull;

  const items = await octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  const entries = items.map((c) => toEntry(c as { sha?: unknown; commit: { message: string } }));
  const messages = entries.map((e) => e.message);

  if (items.length < PR_COMMITS_CAP) {
    return { messages, entries, complete: true, totalCommits: items.length };
  }

  const pr = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner,
    repo,
    pull_number: pullNumber,
  });
  const trueCount: unknown = pr.data?.commits;
  if (typeof trueCount !== 'number') {
    // Cannot verify completeness — fail closed.
    return { messages, entries, complete: false, totalCommits: items.length };
  }
  if (trueCount <= PR_COMMITS_CAP) {
    return { messages, entries, complete: true, totalCommits: trueCount };
  }

  const comparePages = await octokit.paginate('GET /repos/{owner}/{repo}/compare/{basehead}', {
    owner,
    repo,
    basehead: `${pull.baseSha}...${pull.headSha}`,
    per_page: 100,
  });
  const compareCommits = flattenCompareItems(comparePages);
  const compareEntries = compareCommits.map(toEntry);

  return {
    messages: compareEntries.map((e) => e.message),
    entries: compareEntries,
    complete: compareCommits.length >= trueCount,
    totalCommits: trueCount,
  };
}
