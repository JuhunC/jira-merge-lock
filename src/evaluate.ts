import { createHash } from 'node:crypto';
import type { AppConfig } from './config.js';
import type { EvaluatedIssue, JiraIssueOutcome, Verdict } from './types.js';

/** GitHub caps check-run summaries at 65 535 chars; stay safely under. */
const SUMMARY_LIMIT = 60_000;

const RECHECK_HINT =
  'Close/resolve the issues in Jira, then re-run this check — or wait for the automatic re-check.';

const TABLE_HEADER = ['| Issue | Status | Blocking |', '| --- | --- | --- |'];

/**
 * Neutralize attacker-influenced text before it enters the Markdown summary.
 * Issue keys come from commit messages (arbitrary under a permissive
 * JIRA_KEY_REGEX) and status names come from Jira; neither may inject table
 * rows, links, or HTML. Control characters become spaces so a string can
 * never start a new table row; Markdown metacharacters are backslash-escaped.
 */
function escapeMarkdown(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\`*_[\]()<>|#~]/g, '\\$&');
}

/**
 * Strict percent-encoding for a URL path segment. encodeURIComponent leaves
 * ( ) ! ' * raw, and an unencoded ")" would terminate the Markdown link
 * destination — encode those too.
 */
function encodePathSegment(text: string): string {
  return encodeURIComponent(text).replace(
    /[()!'*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Footer link to the public guidelines page, when one is configured. */
function homepageLine(cfg: AppConfig): string | undefined {
  return cfg.publicUrl ? `[What is this check?](${cfg.publicUrl}/)` : undefined;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function verdictFingerprint(
  conclusion: 'success' | 'failure',
  outcomes: JiraIssueOutcome[],
  configHash: string,
): string {
  const pairs = outcomes
    .map((o) => `${o.key}=${o.outcome === 'found' ? o.statusName.trim() : o.outcome}`)
    .sort();
  return sha256(`${conclusion}|${pairs.join(',')}|${configHash}`);
}

function isDone(statusName: string, statusCategoryKey: string | null, cfg: AppConfig): boolean {
  if (cfg.doneStatuses.includes(statusName.trim().toLowerCase())) return true;
  return cfg.doneUseCategory && statusCategoryKey === 'done';
}

function evaluateOutcome(outcome: JiraIssueOutcome, cfg: AppConfig): EvaluatedIssue {
  switch (outcome.outcome) {
    case 'found': {
      const name = outcome.statusName.trim();
      return {
        key: outcome.key,
        statusName: name,
        blocking: !isDone(outcome.statusName, outcome.statusCategoryKey, cfg),
        note: name,
      };
    }
    case 'not_found':
      return { key: outcome.key, statusName: null, blocking: false, note: 'not found (ignored)' };
    case 'forbidden':
      return {
        key: outcome.key,
        statusName: null,
        blocking: true,
        note: 'access denied — cannot verify',
      };
  }
}

function doneStatusesLine(cfg: AppConfig): string {
  const names = cfg.doneStatuses.map((s) => `\`${s}\``).join(', ');
  if (names && cfg.doneUseCategory) {
    return `Done statuses: ${names}, or any status in the Jira \`done\` category.`;
  }
  if (names) return `Done statuses: ${names}.`;
  return 'Done statuses: any status in the Jira `done` category.';
}

function footer(cfg: AppConfig, commitCount: number): string {
  const lines = [doneStatusesLine(cfg), `Scanned ${commitCount} commit messages.`, RECHECK_HINT];
  const homepage = homepageLine(cfg);
  if (homepage) lines.push(homepage);
  return lines.join('\n');
}

function renderRow(issue: EvaluatedIssue, jiraBaseUrl: string): string {
  const link = `[${escapeMarkdown(issue.key)}](${jiraBaseUrl}/browse/${encodePathSegment(issue.key)})`;
  const status = escapeMarkdown(issue.note);
  return `| ${link} | ${status} | ${issue.blocking ? '❌ Yes' : '✅ No'} |`;
}

function assembleSummary(rows: string[], dropped: number, footerText: string): string {
  const lines = [...TABLE_HEADER, ...rows];
  if (dropped > 0) lines.push(`| …and ${dropped} more issues | | |`);
  return `${lines.join('\n')}\n\n${footerText}`;
}

function renderSummary(issues: EvaluatedIssue[], cfg: AppConfig, commitCount: number): string {
  const footerText = footer(cfg, commitCount);
  const rows = issues.map((i) => renderRow(i, cfg.jira.baseUrl));

  const full = assembleSummary(rows, 0, footerText);
  if (full.length <= SUMMARY_LIMIT) return full;

  // Reserve space using the worst-case marker (dropped <= rows.length, so the
  // real marker is never longer than this one).
  const fixedLength = assembleSummary([], rows.length, footerText).length;
  let length = fixedLength;
  let included = 0;
  for (const row of rows) {
    if (length + row.length + 1 > SUMMARY_LIMIT) break;
    length += row.length + 1;
    included += 1;
  }
  return assembleSummary(rows.slice(0, included), rows.length - included, footerText);
}

/** Append the homepage footer link (when configured) to a list of summary lines. */
function withHomepage(lines: string[], cfg: AppConfig): string {
  const homepage = homepageLine(cfg);
  return (homepage ? [...lines, '', homepage] : lines).join('\n');
}

function zeroKeyVerdict(cfg: AppConfig, commitCount: number): Verdict {
  const scanned = `Scanned ${commitCount} commit messages.`;
  if (cfg.requireIssueKey) {
    return {
      conclusion: 'failure',
      issues: [],
      title: 'No Jira issues referenced — at least one issue key is required',
      summary: withHomepage(
        [
          'This check requires every pull request to reference at least one Jira issue (`REQUIRE_ISSUE_KEY=true`), but no issue keys were found in any commit message.',
          '',
          scanned,
          '',
          'Add a Jira issue key (e.g. `PRJ-123`) to a commit message, then re-run this check.',
        ],
        cfg,
      ),
      fingerprint: verdictFingerprint('failure', [], cfg.configHash),
    };
  }
  return {
    conclusion: 'success',
    issues: [],
    title: 'No Jira issues referenced',
    summary: withHomepage(
      ['No Jira issue keys were found in any commit message — nothing to verify.', '', scanned],
      cfg,
    ),
    fingerprint: verdictFingerprint('success', [], cfg.configHash),
  };
}

export function buildVerdictFromOutcomes(
  outcomes: JiraIssueOutcome[],
  cfg: AppConfig,
  meta: { commitCount: number },
): Verdict {
  if (outcomes.length === 0) return zeroKeyVerdict(cfg, meta.commitCount);

  const issues = outcomes
    .map((o) => evaluateOutcome(o, cfg))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const blockingCount = issues.filter((i) => i.blocking).length;
  const conclusion = blockingCount > 0 ? 'failure' : 'success';
  const title =
    blockingCount > 0
      ? `Blocked: ${blockingCount} of ${issues.length} Jira issues not done`
      : `All ${issues.length} Jira issues done`;

  return {
    conclusion,
    issues,
    title,
    summary: renderSummary(issues, cfg, meta.commitCount),
    fingerprint: verdictFingerprint(conclusion, outcomes, cfg.configHash),
  };
}

export function buildErrorVerdict(
  kind: 'jira_unreachable' | 'too_many_commits' | 'jira_auth_failed',
  cfg: AppConfig,
  meta?: { totalCommits?: number },
): Verdict {
  if (kind === 'jira_auth_failed') {
    return {
      conclusion: 'failure',
      issues: [],
      title: 'Jira authentication failed — cannot verify referenced issues',
      summary: withHomepage(
        [
          "Jira rejected this app's credentials, so the issues referenced by this pull request cannot be verified.",
          '',
          'This is a configuration failure of the jira-merge-lock deployment, not a problem with this pull request — an operator must fix the `JIRA_*` configuration (auth method, credentials, base URL). Developers cannot resolve this from the PR.',
          '',
          'Once the credentials are fixed, re-run this check or wait for the automatic re-check.',
        ],
        cfg,
      ),
      fingerprint: sha256(`jira_auth_failed|${cfg.configHash}`),
    };
  }

  if (kind === 'jira_unreachable') {
    return {
      conclusion: 'failure',
      issues: [],
      title: 'Jira unreachable — cannot verify referenced issues',
      summary: withHomepage(
        [
          'Jira could not be reached, so the issues referenced by this pull request cannot be verified.',
          '',
          'This failure is posted only for commits that have never been verified — commits that already carry a verdict keep it, because an outage says nothing about issue state.',
          '',
          'No action is needed: the check re-evaluates automatically and heals itself once Jira is reachable again (or re-run it manually).',
        ],
        cfg,
      ),
      fingerprint: sha256(`jira_unreachable|${cfg.configHash}`),
    };
  }

  const total = meta?.totalCommits;
  const countPhrase = total !== undefined ? `all ${total} commits` : 'all commits';
  return {
    conclusion: 'failure',
    issues: [],
    title: `Cannot verify ${countPhrase} — split the pull request`,
    summary: withHomepage(
      [
        `This pull request has more commits than can be fully enumerated via the GitHub API${total !== undefined ? ` (${total} total)` : ''}, so some commit messages could not be scanned for Jira issue keys.`,
        '',
        'Unscanned commits could reference unfinished Jira issues, so this check fails closed.',
        '',
        'Split the pull request into smaller ones, then re-run this check.',
      ],
      cfg,
    ),
    fingerprint: sha256(`too_many_commits|${cfg.configHash}`),
  };
}
