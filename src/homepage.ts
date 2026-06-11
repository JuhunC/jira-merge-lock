import type { AppConfig } from './config.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Developer-guidelines page served at GET /. Renders ONLY non-sensitive
 * config: never the webhook secret, private key, app id, or any cfg.jira.*
 * value (including baseUrl) — the page is publicly reachable.
 */
export function renderHomepage(cfg: AppConfig): string {
  const checkName = escapeHtml(cfg.checkName);
  const prefix = escapeHtml(cfg.rulesetNamePrefix);
  const regex = escapeHtml(cfg.keyRegexSource);

  const allowlist =
    cfg.projectKeys.length > 0
      ? `<p>Only keys from these Jira projects are considered: ${cfg.projectKeys
          .map((k) => `<code>${escapeHtml(k)}</code>`)
          .join(', ')}. Anything else matching the pattern is ignored.</p>`
      : `<p>Keys from any Jira project matching the pattern are considered.</p>`;

  const statusList =
    cfg.doneStatuses.length > 0
      ? `<p>An issue counts as done when its Jira status (case-insensitive) is one of:</p>
<ul>
${cfg.doneStatuses.map((s) => `  <li><code>${escapeHtml(s)}</code></li>`).join('\n')}
</ul>`
      : '';

  const categoryNote = cfg.doneUseCategory
    ? `<p>Category mode is enabled: an issue whose Jira <strong>status category</strong> is <code>done</code> also counts as done, regardless of the status name.</p>`
    : '';

  const unlockWait =
    cfg.pollIntervalSeconds > 0
      ? `or wait up to <strong>${cfg.pollIntervalSeconds} seconds</strong> for the automatic re-check to pick up the change.`
      : `(automatic re-checking is disabled on this deployment, so a manual re-run is required).`;

  const zeroKeyPolicy = cfg.requireIssueKey
    ? `<p>On this deployment a pull request <strong>must reference at least one Jira issue key</strong> in its commit messages — a pull request with no keys is blocked until one is added.</p>`
    : `<p>A pull request whose commit messages reference no Jira issue keys <strong>passes this check automatically</strong>.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${checkName} — merge check guidelines</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    max-width: 44rem;
    margin: 0 auto;
    padding: 2rem 1.25rem 4rem;
    line-height: 1.6;
  }
  h1 { font-size: 1.6rem; }
  h2 { font-size: 1.2rem; margin-top: 2rem; }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.92em;
    background: rgba(128, 128, 128, 0.16);
    padding: 0.1em 0.35em;
    border-radius: 4px;
  }
  li { margin: 0.3rem 0; }
  dt { font-weight: 600; margin-top: 1rem; }
</style>
</head>
<body>
<h1><code>${checkName}</code> — why is my merge blocked?</h1>
<p>This check scans every commit message in your pull request for Jira issue keys
(like <code>PRJ-123</code>), looks each referenced issue up in Jira, and
<strong>blocks the merge while any referenced issue is not done</strong>.
It appears on your pull request as a required status check named <code>${checkName}</code>.</p>

<h2>How Jira issue keys are detected</h2>
<p>Commit messages are matched against the pattern <code>${regex}</code>
(word-boundary wrapped). Matched keys are uppercased and de-duplicated.</p>
${allowlist}

<h2>Which statuses unblock a merge</h2>
${statusList}
${categoryNote}

<h2>Where this check applies</h2>
<p>The check is enforced on repositories and branches covered by
<strong>organization rulesets whose name starts with</strong> <code>${prefix}</code>
(i.e. rulesets named <code>${prefix}*</code>). This page explains the naming
convention only — it does not show live data about your organization. Pull
requests outside any matching ruleset are not blocked by this check.</p>

<h2>What blocks a merge</h2>
<ul>
  <li>Any referenced Jira issue whose status is <strong>not done</strong> (per the list above).</li>
  <li>Any referenced issue that <strong>cannot be verified</strong> (for example, access denied in Jira).</li>
  <li>A <strong>Jira outage</strong> at the moment a newly pushed commit is first evaluated.</li>
  <li>Pull requests too large to enumerate completely (more than 250 commits) — split the PR.</li>
</ul>

<h2>How to unlock</h2>
<ol>
  <li>Close or resolve the blocking issues in Jira.</li>
  <li>Press <strong>Re-run</strong> on the <code>${checkName}</code> check in GitHub,
      ${unlockWait}</li>
</ol>

<h2>Pull requests without Jira keys</h2>
${zeroKeyPolicy}

<h2>FAQ</h2>
<dl>
  <dt>A key was reported as “not found” and ignored — why?</dt>
  <dd>The detection pattern inevitably matches some strings that merely look
  like issue keys (for example <code>UTF-8</code>). A key that does not exist
  in Jira is treated as a false positive and never blocks the merge. Issues
  that exist but cannot be read, on the other hand, block until verifiable.</dd>
  <dt>Who manages the rulesets?</dt>
  <dd>Your organization administrators. They decide which repositories and
  branches each <code>${prefix}*</code> ruleset covers; this app only maintains
  its own required-check entry inside those rulesets. To opt a ruleset out of
  this check, an admin renames it so it no longer starts with <code>${prefix}</code>.</dd>
</dl>
</body>
</html>
`;
}
