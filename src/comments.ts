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
 *
 * The check run's summary shows the EVIDENCE, not just the verdict: how many
 * comments counted and from whom, plus what was excluded and why — so a
 * developer never has to ask "I commented, why is it still blocked?".
 */

export type CommentSourceKind = 'conversation comment' | 'inline review comment' | 'review';

export interface CountedComment {
  login: string;
  source: CommentSourceKind;
}

export interface CommentCountDetail {
  /** Qualifying comments (the number the verdict is judged on). */
  count: number;
  authorLogin: string;
  /** One entry per qualifying comment, in source order. */
  counted: CountedComment[];
  excludedAuthor: number;
  excludedBots: number;
  excludedEmptyReviews: number;
  /** true when a source hit the pagination cap — counts are lower bounds. */
  truncated: boolean;
}

interface CommentLike {
  user?: { login?: string; type?: string } | null;
  body?: string | null;
}

const PAGE_SIZE = 100;
/** Pagination cap per source: 3 pages = 300 items. PRs with more comments
 * than that have long satisfied any sane threshold; the summary says when
 * the cap was hit. */
const MAX_PAGES_PER_SOURCE = 3;
/** Cap on the names listed in the check-run summary. */
const LISTED_LIMIT = 20;

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

/** Count every comment with full attribution (no early exit — the check-run
 * summary reports the true count and who it came from). Each source is read
 * page-by-page up to MAX_PAGES_PER_SOURCE. */
export async function countNonAuthorComments(
  octokit: OctokitLike,
  pull: PullRef,
): Promise<CommentCountDetail> {
  const authorLogin = await resolveAuthor(octokit, pull);
  const detail: CommentCountDetail = {
    count: 0,
    authorLogin,
    counted: [],
    excludedAuthor: 0,
    excludedBots: 0,
    excludedEmptyReviews: 0,
    truncated: false,
  };

  const sources: Array<{
    route: string;
    params: Record<string, unknown>;
    source: CommentSourceKind;
    bodyRequired: boolean;
  }> = [
    {
      // PR conversation comments live on the ISSUE comments endpoint.
      route: 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
      params: { owner: pull.owner, repo: pull.repo, issue_number: pull.pullNumber },
      source: 'conversation comment',
      bodyRequired: false,
    },
    {
      route: 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments',
      params: { owner: pull.owner, repo: pull.repo, pull_number: pull.pullNumber },
      source: 'inline review comment',
      bodyRequired: false,
    },
    {
      // Reviews count only when they carry text — a silent Approve is not a comment.
      route: 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      params: { owner: pull.owner, repo: pull.repo, pull_number: pull.pullNumber },
      source: 'review',
      bodyRequired: true,
    },
  ];

  for (const src of sources) {
    for (let page = 1; page <= MAX_PAGES_PER_SOURCE; page++) {
      const res = await octokit.request(src.route, {
        ...src.params,
        per_page: PAGE_SIZE,
        page,
      });
      const items = (Array.isArray(res.data) ? res.data : []) as CommentLike[];
      for (const item of items) {
        const login = item.user?.login;
        if (typeof login !== 'string' || login.length === 0) continue; // deleted account
        if (login.toLowerCase() === authorLogin.toLowerCase()) {
          detail.excludedAuthor += 1;
          continue;
        }
        if (item.user?.type === 'Bot') {
          detail.excludedBots += 1;
          continue;
        }
        if (src.bodyRequired && !(typeof item.body === 'string' && item.body.trim().length > 0)) {
          detail.excludedEmptyReviews += 1;
          continue;
        }
        detail.counted.push({ login, source: src.source });
        detail.count += 1;
      }
      if (items.length < PAGE_SIZE) break;
      if (page === MAX_PAGES_PER_SOURCE) detail.truncated = true;
    }
  }
  return detail;
}

/** Footer link to the public guidelines page, when one is configured. */
function homepageLine(cfg: AppConfig): string[] {
  return cfg.publicUrl ? ['', `[What is this check?](${cfg.publicUrl}/)`] : [];
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

/** Same hardening as the Jira table: logins come from the GitHub API (safe
 * charset), but nothing user-influenced enters the Markdown unescaped. */
function escapeMarkdown(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\`*_[\]()<>|#~]/g, '\\$&');
}

const COUNTING_RULES =
  'Counted: PR conversation comments, inline review comments, and reviews with body text — written by anyone **other than the pull request author**. Bot accounts do not count.';

function countedTable(counted: CountedComment[]): string[] {
  const shown = counted.slice(0, LISTED_LIMIT);
  const lines = [
    '| # | User | Source |',
    '| --- | --- | --- |',
    ...shown.map((c, i) => `| ${i + 1} | ${escapeMarkdown(c.login)} | ${c.source} |`),
  ];
  if (counted.length > shown.length) {
    lines.push(`| | …and ${counted.length - shown.length} more | |`);
  }
  return lines;
}

function exclusionsLine(detail: CommentCountDetail): string[] {
  const parts: string[] = [];
  if (detail.excludedAuthor > 0) {
    parts.push(`${detail.excludedAuthor} comment${plural(detail.excludedAuthor)} from the PR author`);
  }
  if (detail.excludedBots > 0) {
    parts.push(`${detail.excludedBots} from bot account${plural(detail.excludedBots)}`);
  }
  if (detail.excludedEmptyReviews > 0) {
    parts.push(`${detail.excludedEmptyReviews} review${plural(detail.excludedEmptyReviews)} without body text`);
  }
  if (parts.length === 0) return [];
  return ['', `Not counted: ${parts.join(' · ')}.`];
}

/** Pure verdict for the comment check. The fingerprint caps the count at the
 * threshold so steady-state poll cycles stay write-free once satisfied; the
 * listed evidence refreshes on every comment/review event (the live path
 * always rewrites the run). */
export function buildCommentVerdict(detail: CommentCountDetail, cfg: AppConfig): Verdict {
  const min = cfg.minPrComments;
  const count = detail.count;
  const capped = Math.min(count, min);
  const conclusion = capped >= min ? 'success' : 'failure';
  // Readable on purpose (shows up as external_id in API responses): the
  // capped count makes success stable and failure update as comments arrive.
  const fingerprint = `comments|${conclusion}|${capped}/${min}`;

  const evidence =
    count > 0
      ? [
          `**${count}** qualifying comment${plural(count)} from someone other than the author (required: **${min}**) — counted:`,
          '',
          ...countedTable(detail.counted),
        ]
      : [
          `**No** qualifying comments from someone other than the author were found (required: **${min}**).`,
        ];

  const truncationNote = detail.truncated
    ? ['', `Listing truncated: only the first ${MAX_PAGES_PER_SOURCE * PAGE_SIZE} items per source were examined — counts are lower bounds.`]
    : [];

  if (conclusion === 'success') {
    return {
      conclusion,
      issues: [],
      title: `Discussion requirement met — ${count} comment${plural(count)} from others (required: ${min})`,
      summary: [
        ...evidence,
        ...exclusionsLine(detail),
        ...truncationNote,
        '',
        COUNTING_RULES,
        ...homepageLine(cfg),
      ].join('\n'),
      fingerprint,
    };
  }
  return {
    conclusion,
    issues: [],
    title: `Blocked: needs ${min} comment${plural(min)} from someone other than the author (found ${count})`,
    summary: [
      ...evidence,
      ...exclusionsLine(detail),
      ...truncationNote,
      '',
      COUNTING_RULES,
      '',
      'Ask a teammate to review and comment on this pull request. The check re-runs automatically when comments are added or removed (and on every poll cycle); it can also be re-run manually.',
      ...homepageLine(cfg),
    ].join('\n'),
    fingerprint,
  };
}
