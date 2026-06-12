import type { AppConfig } from './config.js';
import type { OctokitLike, PullRef, Verdict } from './types.js';

/**
 * The MIN_PR_COMMENTS discussion gate: a pull request needs at least N
 * comments from someone OTHER than the PR author before it may merge.
 *
 * What counts as a comment (each item once):
 *  - PR conversation comments (the issue-comments timeline),
 *  - inline review comments on the diff,
 *  - submitted reviews that carry body text (a bare Approve without text is
 *    not a comment).
 *
 * Who counts: any user except the PR author and except bot accounts
 * (user.type === "Bot") — CI bots commenting on every PR must not satisfy a
 * human-discussion requirement. Comments whose author GitHub no longer knows
 * (deleted accounts) are skipped: we cannot prove they weren't the author.
 */

interface CommentLike {
  user?: { login?: string; type?: string } | null;
  body?: string | null;
}

function countsAsOther(item: CommentLike, authorLogin: string): boolean {
  const login = item.user?.login;
  if (typeof login !== 'string' || login.length === 0) return false;
  if (login.toLowerCase() === authorLogin.toLowerCase()) return false;
  if (item.user?.type === 'Bot') return false;
  return true;
}

/** Resolve the PR author when the trigger payload didn't carry it
 * (check_run.rerequested payloads list PRs without `user`). */
async function resolveAuthor(octokit: OctokitLike, pull: PullRef): Promise<string> {
  if (pull.authorLogin) return pull.authorLogin;
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: pull.owner,
    repo: pull.repo,
    pull_number: pull.pullNumber,
  });
  const login = (data as { user?: { login?: string } | null })?.user?.login;
  if (typeof login !== 'string' || login.length === 0) {
    throw new Error(
      `cannot determine the author of ${pull.owner}/${pull.repo}#${pull.pullNumber} — comment check needs it`,
    );
  }
  return login;
}

/** Count non-author comments, stopping at `enough` (counting past the
 * threshold buys nothing and PRs can carry hundreds of comments). Endpoints
 * are consulted cheapest-signal-first; each stops the sweep once satisfied. */
export async function countNonAuthorComments(
  octokit: OctokitLike,
  pull: PullRef,
  enough: number,
): Promise<{ count: number; authorLogin: string }> {
  const authorLogin = await resolveAuthor(octokit, pull);
  let count = 0;

  const sources: Array<{ route: string; params: Record<string, unknown>; bodyRequired: boolean }> = [
    {
      // PR conversation comments live on the ISSUE comments endpoint.
      route: 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
      params: { owner: pull.owner, repo: pull.repo, issue_number: pull.pullNumber, per_page: 100 },
      bodyRequired: false,
    },
    {
      route: 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments',
      params: { owner: pull.owner, repo: pull.repo, pull_number: pull.pullNumber, per_page: 100 },
      bodyRequired: false,
    },
    {
      // Reviews count only when they carry text — a silent Approve is not a comment.
      route: 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      params: { owner: pull.owner, repo: pull.repo, pull_number: pull.pullNumber, per_page: 100 },
      bodyRequired: true,
    },
  ];

  for (const source of sources) {
    if (count >= enough) break;
    const items = (await octokit.paginate(source.route, source.params)) as CommentLike[];
    for (const item of items) {
      if (!countsAsOther(item, authorLogin)) continue;
      if (source.bodyRequired && !(typeof item.body === 'string' && item.body.trim().length > 0)) {
        continue;
      }
      count += 1;
      if (count >= enough) break;
    }
  }
  return { count, authorLogin };
}

/** Footer link to the public guidelines page, when one is configured. */
function homepageLine(cfg: AppConfig): string[] {
  return cfg.publicUrl ? ['', `[What is this check?](${cfg.publicUrl}/)`] : [];
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

const COUNTING_RULES = [
  'Counted: PR conversation comments, inline review comments, and reviews with body text — written by anyone **other than the pull request author**. Bot accounts do not count.',
];

/** Pure verdict for the comment check. `count` is capped at the threshold by
 * the caller, which keeps success fingerprints stable as discussion continues
 * (no check-run rewrite per additional comment). */
export function buildCommentVerdict(count: number, cfg: AppConfig): Verdict {
  const min = cfg.minPrComments;
  const capped = Math.min(count, min);
  const conclusion = capped >= min ? 'success' : 'failure';
  // Readable on purpose (shows up as external_id in API responses): the
  // capped count makes success stable and failure update as comments arrive.
  const fingerprint = `comments|${conclusion}|${capped}/${min}`;

  if (conclusion === 'success') {
    return {
      conclusion,
      issues: [],
      title: `Discussion requirement met (≥${min} comment${plural(min)} from others)`,
      summary: [
        `This pull request has at least **${min}** comment${plural(min)} from someone other than its author — the discussion requirement is met.`,
        '',
        ...COUNTING_RULES,
        ...homepageLine(cfg),
      ].join('\n'),
      fingerprint,
    };
  }
  return {
    conclusion,
    issues: [],
    title: `Blocked: needs ${min} comment${plural(min)} from someone other than the author (found ${capped})`,
    summary: [
      `This pull request requires at least **${min}** comment${plural(min)} from someone other than its author before it can merge; **${capped}** ${capped === 1 ? 'was' : 'were'} found.`,
      '',
      ...COUNTING_RULES,
      '',
      'Ask a teammate to review and comment on this pull request. The check re-runs automatically when comments are added or removed (and on every poll cycle); it can also be re-run manually.',
      ...homepageLine(cfg),
    ].join('\n'),
    fingerprint,
  };
}
