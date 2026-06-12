import type { AppConfig } from './config.js';
import { APP_NAME, escapeHtml, renderPage } from './webui.js';

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
<p>${cfg.doneStatuses.map((s) => `<code>${escapeHtml(s)}</code>`).join(' ')}</p>`
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

  const gateOn = cfg.minPrComments > 0;
  const commentGate = gateOn
    ? `<section class="card" id="discussion">
<h2>Required discussion (<code>${escapeHtml(cfg.commentCheckName)}</code>)</h2>
<p>This deployment also requires every pull request to have at least
<strong>${cfg.minPrComments} comment${cfg.minPrComments === 1 ? '' : 's'} from someone other than its author</strong>
before it can merge — posted as a separate required check named
<code>${escapeHtml(cfg.commentCheckName)}</code> on the same branches.</p>
<p>What counts: PR conversation comments, inline review comments, and reviews
with body text. The pull request author's own comments and bot accounts do
<strong>not</strong> count. The check re-runs automatically when comments are
added or removed.</p>
</section>`
    : '';

  const body = `<section class="card unlock" id="unlock">
<h2>How to unlock</h2>
<ol>
  <li>Close or resolve the blocking issues in Jira.</li>
  <li>Press <strong>Re-run</strong> on the <code>${checkName}</code> check in GitHub,
      ${unlockWait}</li>
</ol>
</section>

<section class="card" id="blocks">
<h2>What blocks a merge</h2>
<ul>
  <li>Any referenced Jira issue whose status is <strong>not done</strong> (per the list below).</li>
  <li>Any referenced issue that <strong>cannot be verified</strong> (for example, access denied in Jira).</li>
  <li>A <strong>Jira outage</strong> — while Jira is unreachable, every evaluation fails
      until Jira is reachable again; the check then recovers automatically.</li>
  <li>Pull requests too large to enumerate completely (more than 250 commits) — split the PR.</li>
</ul>
</section>

<section class="card" id="statuses">
<h2>Which statuses unblock a merge</h2>
${statusList}
${categoryNote}
</section>

<section class="card" id="detection">
<h2>How Jira issue keys are detected</h2>
<p>Commit messages are matched against the pattern <code>${regex}</code>
(word-boundary wrapped). Matched keys are uppercased and de-duplicated.</p>
${allowlist}
</section>

<section class="card" id="zero-key">
<h2>Pull requests without Jira keys</h2>
${zeroKeyPolicy}
</section>

${commentGate}

<section class="card" id="scope">
<h2>Where this check applies</h2>
<p>The check is enforced on repositories and branches covered by
<strong>organization rulesets whose name starts with</strong> <code>${prefix}</code>
(i.e. rulesets named <code>${prefix}*</code>). This page explains the naming
convention only — it does not show live data about your organization. Pull
requests outside any matching ruleset are not blocked by this check.</p>
</section>

<section class="card" id="faq">
<h2>FAQ</h2>
<dl class="faq">
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
</section>`;

  return renderPage({
    title: `${APP_NAME} — merge check guidelines`,
    heading: 'Why is my merge blocked?',
    tagline: `This check scans every commit message in your pull request for Jira issue keys
(like <code>PRJ-123</code>), looks each referenced issue up in Jira, and
<strong>blocks the merge while any referenced issue is not done</strong>.
It appears on your pull request as a required status check named <code>${checkName}</code>.`,
    headerAside: `<a class="cta" href="/status">View deployment status</a>`,
    nav: [
      { href: '#unlock', label: 'How to unlock' },
      { href: '#blocks', label: 'What blocks a merge' },
      { href: '#statuses', label: 'Done statuses' },
      { href: '#detection', label: 'Key detection' },
      ...(gateOn ? [{ href: '#discussion', label: 'Required discussion' }] : []),
      { href: '#scope', label: 'Scope' },
      { href: '#faq', label: 'FAQ' },
    ],
    extraCss: `
  dl.faq { margin: 0; }
  dl.faq dt { font-weight: 600; margin-top: 1rem; }
  dl.faq dd { margin: 0.25rem 0 0; }
  section.card.unlock { border-color: var(--ok-border); }
  section.card.unlock > h2 { border-bottom-color: var(--ok-border); }
`,
    body,
    footerExtra: `<p>Live deployment status — GitHub and Jira connectivity and the most
recent background poll cycle — is published at <a href="/status">/status</a>
(machine-readable at <a href="/status.json">/status.json</a>).</p>`,
  });
}
