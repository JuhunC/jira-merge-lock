import type { AppConfig } from './config.js';
import {
  deriveOverall,
  liveLocks,
  type ComponentHealth,
  type EvaluationStatus,
  type StatusSnapshot,
} from './status.js';
import type { JiraAuthMethod } from './types.js';
import { APP_NAME, escapeHtml, renderPage } from './webui.js';

/**
 * Live operational status served at GET /status (HTML, auto-refreshing) and
 * GET /status.json. The page is publicly reachable, like the homepage. It
 * DELIBERATELY shows the configured GitHub and Jira base URLs plus org/repo/
 * PR identifiers and ruleset names (a deployment decision — operators who
 * consider those sensitive must front the service with auth), but never
 * credentials, the app id, or raw error messages — only the fixed failure
 * categories recorded in StatusTracker.
 */

const OVERALL_LABEL = {
  ok: 'Operational',
  degraded: 'Degraded',
  starting: 'Starting up',
} as const;

const OVERALL_CLASS = { ok: 'ok', degraded: 'bad', starting: 'neutral' } as const;

const AUTH_LABEL: Record<JiraAuthMethod, string> = {
  cloud: 'Jira Cloud (email + API token)',
  pat: 'personal access token (Server/DC)',
  basic: 'basic auth (username + password)',
};

export function githubApiTarget(cfg: AppConfig): string {
  return cfg.githubBaseUrl ?? 'https://api.github.com';
}

/** Web UI base for PR links: GHES API root minus /api/v3, else github.com. */
export function githubWebBase(cfg: AppConfig): string {
  if (!cfg.githubBaseUrl) return 'https://github.com';
  return cfg.githubBaseUrl.replace(/\/api\/v3\/?$/, '');
}

function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 120) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function fmtWhen(ts: number | null, now: number): string {
  if (ts === null) return 'never';
  return `${fmtAgo(now - ts)} <span class="muted">(${new Date(ts).toISOString()})</span>`;
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return 'unknown';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function fmtUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function badge(kind: 'ok' | 'bad' | 'neutral', label: string): string {
  return `<span class="badge ${kind}">${escapeHtml(label)}</span>`;
}

function componentWord(c: ComponentHealth): { dot: string; word: string } {
  switch (c.state) {
    case 'pending':
      return { dot: 'neutral', word: 'not yet attempted' };
    case 'ok':
      return { dot: 'ok', word: 'connected' };
    case 'failed':
      return { dot: 'bad', word: 'failing' };
  }
}

function stateBadge(c: ComponentHealth): string {
  const { dot, word } = componentWord(c);
  return badge(dot as 'ok' | 'bad' | 'neutral', word);
}

function failureCell(c: ComponentHealth, now: number): string {
  if (c.lastFailAt === null) return '<span class="muted">never</span>';
  const reason = c.lastFailReason ? ` — ${escapeHtml(c.lastFailReason)}` : '';
  return `${fmtWhen(c.lastFailAt, now)}${reason}`;
}

function pollWord(state: StatusSnapshot['poll']['state']): { dot: string; word: string } {
  switch (state) {
    case 'pending':
      return { dot: 'neutral', word: 'no cycle yet' };
    case 'running':
      return { dot: 'neutral', word: 'running' };
    case 'ok':
      return { dot: 'ok', word: 'succeeded' };
    case 'failed':
      return { dot: 'bad', word: 'failed' };
  }
}

function pollBadge(state: StatusSnapshot['poll']['state']): string {
  const { dot, word } = pollWord(state);
  return badge(dot as 'ok' | 'bad' | 'neutral', word);
}

function pollCycleCell(poll: StatusSnapshot['poll'], now: number): string {
  switch (poll.state) {
    case 'pending':
      return '<span class="muted">none yet</span>';
    case 'running':
      return `started ${fmtWhen(poll.lastStartedAt, now)}`;
    case 'ok':
      return `completed ${fmtWhen(poll.lastCompletedAt, now)} · took ${fmtDuration(poll.lastDurationMs)}`;
    case 'failed': {
      const reason = poll.lastFailReason ? ` — ${escapeHtml(poll.lastFailReason)}` : '';
      const lastGood =
        poll.lastCompletedAt !== null
          ? ` · last successful cycle ${fmtWhen(poll.lastCompletedAt, now)}`
          : '';
      return `failed ${fmtWhen(poll.lastFailAt, now)}${reason}${lastGood}`;
    }
  }
}

function stat(value: number, label: string): string {
  return `<div class="stat"><div class="num">${value}</div><div class="label">${label}</div></div>`;
}

function vital(href: string, label: string, dot: string, value: string, sub: string): string {
  return `<a class="vital" href="${href}">
<div class="vlabel">${escapeHtml(label)}</div>
<div class="vvalue"><span class="dot ${dot}"></span>${escapeHtml(value)}</div>
<div class="vsub">${sub}</div>
</a>`;
}

function enforcementBadge(enforcement: string): string {
  switch (enforcement) {
    case 'active':
      return badge('ok', 'active');
    case 'evaluate':
      return badge('neutral', 'evaluate');
    case 'disabled':
      return badge('bad', 'disabled');
    default:
      return badge('neutral', enforcement);
  }
}

function requiredBadge(present: boolean): string {
  return present ? badge('ok', 'required') : badge('bad', 'missing');
}

function prLink(e: EvaluationStatus, webBase: string): string {
  const label = escapeHtml(`${e.owner}/${e.repo}#${e.pullNumber}`);
  const href = `${webBase}/${encodeURIComponent(e.owner)}/${encodeURIComponent(e.repo)}/pull/${e.pullNumber}`;
  return `<a href="${escapeHtml(href)}">${label}</a>`;
}

/** Check names are namespaced ("merge-lock/jira-issue") — the tail segment
 * is enough inside a table cell. */
function checkChip(check: string): string {
  const tail = check.includes('/') ? check.slice(check.lastIndexOf('/') + 1) : check;
  return `<code title="${escapeHtml(check)}">${escapeHtml(tail)}</code>`;
}

function rulesetsCard(cfg: AppConfig, snap: StatusSnapshot, now: number): string {
  const prefix = escapeHtml(cfg.rulesetNamePrefix);
  const orgs = snap.rulesets;
  const total = orgs.reduce((n, o) => n + o.rulesets.length, 0);
  const gateOn = cfg.minPrComments > 0;

  let body: string;
  if (orgs.length === 0) {
    body = `<p class="muted">No <code>${prefix}*</code> rulesets seen yet — this table fills in
after the first poll cycle (one runs at startup). If it stays empty, no org ruleset name
starts with <code>${prefix}</code>.</p>`;
  } else {
    const rows = orgs.flatMap((o) =>
      o.rulesets.map(
        (r) => `<tr>
  <td>${escapeHtml(o.org)}</td>
  <td><code>${escapeHtml(r.name)}</code></td>
  <td>${enforcementBadge(r.enforcement)}</td>
  <td>${requiredBadge(r.requiresJiraCheck)}</td>
  <td>${
    gateOn
      ? requiredBadge(r.requiresCommentCheck)
      : r.requiresCommentCheck
        ? badge('neutral', 'still present')
        : '<span class="muted">—</span>'
  }</td>
</tr>`,
      ),
    );
    const seenAt = Math.max(...orgs.map((o) => o.seenAt));
    body = `<table>
<thead><tr><th>Org</th><th>Ruleset</th><th>Enforcement</th><th>${checkChip(cfg.checkName)}</th><th>${checkChip(cfg.commentCheckName)}</th></tr></thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>
<p class="muted">Last verified ${fmtWhen(seenAt, now)} · refreshed each poll cycle and on
ruleset events. Only <strong>active</strong> branch rulesets enforce the lock${
      gateOn ? '' : ` · the ${checkChip(cfg.commentCheckName)} column is inactive while the comment gate is disabled`
    }.</p>`;
  }

  return `<section class="card" id="rulesets">
<div class="card-head"><h2>Rulesets</h2>${badge('neutral', `${total} discovered`)}</div>
${body}
</section>`;
}

function pullRequestsCard(cfg: AppConfig, snap: StatusSnapshot, now: number): string {
  const webBase = githubWebBase(cfg);
  const locks = liveLocks(snap, cfg.pollIntervalSeconds, now);
  const headBadge =
    locks.length > 0
      ? badge('bad', `${locks.length} merge${locks.length === 1 ? '' : 's'} blocked`)
      : badge('ok', 'no merges blocked');

  const blockedBody =
    locks.length === 0
      ? `<p class="muted">No pull request is currently held by either check (as far as this
process has seen — restarts clear this view until the next poll cycle rebuilds it).</p>`
      : `<table>
<thead><tr><th>Pull request</th><th>Check</th><th>Why it blocks</th><th>Last checked</th></tr></thead>
<tbody>
${locks
  .map(
    (e) => `<tr>
  <td>${prLink(e, webBase)}</td>
  <td>${checkChip(e.check)}</td>
  <td>${escapeHtml(e.title)}</td>
  <td>${fmtAgo(now - e.at)}</td>
</tr>`,
  )
  .join('\n')}
</tbody>
</table>`;

  const recent = snap.recentEvaluations.slice(0, 10);
  const recentBody =
    recent.length === 0
      ? `<p class="muted">No evaluations yet.</p>`
      : `<table>
<thead><tr><th>When</th><th>Pull request</th><th>Check</th><th>Result</th><th>Verdict</th></tr></thead>
<tbody>
${recent
  .map(
    (e) => `<tr>
  <td>${fmtAgo(now - e.at)}</td>
  <td>${prLink(e, webBase)}</td>
  <td>${checkChip(e.check)}</td>
  <td>${e.conclusion === 'success' ? badge('ok', 'pass') : badge('bad', 'blocked')}</td>
  <td>${escapeHtml(e.title)}</td>
</tr>`,
  )
  .join('\n')}
</tbody>
</table>
<p class="muted">Verdict changes only — steady-state poll cycles that confirm an unchanged
verdict are not repeated here. This view lives in memory and resets on restart; the
authoritative state is always the check runs on GitHub.</p>`;

  return `<section class="card" id="pulls">
<div class="card-head"><h2>Pull requests &amp; merge locks</h2>${headBadge}</div>
<h3>Currently blocked</h3>
${blockedBody}
<h3>Recent evaluations</h3>
${recentBody}
</section>`;
}

export function renderStatusPage(
  cfg: AppConfig,
  snap: StatusSnapshot,
  now: number = Date.now(),
): string {
  const checkName = escapeHtml(cfg.checkName);
  const prefix = escapeHtml(cfg.rulesetNamePrefix);
  const overall = deriveOverall(snap, cfg.pollIntervalSeconds, now);

  const webhookCell =
    snap.webhook.lastAt === null
      ? `${badge('neutral', 'none since startup')} <span class="muted">GitHub sends events only when something changes — a quiet period is normal.</span>`
      : `<code>${escapeHtml(snap.webhook.lastEvent ?? '')}</code> · ${fmtWhen(snap.webhook.lastAt, now)}`;

  const schedule =
    cfg.pollIntervalSeconds > 0
      ? `every ${cfg.pollIntervalSeconds} seconds (±10% jitter), plus one cycle at startup`
      : 'recurring polling disabled — one cycle at startup, then webhook-driven evaluations only';

  const injectedChecks =
    cfg.minPrComments > 0
      ? `<code>${checkName}</code> and <code>${escapeHtml(cfg.commentCheckName)}</code> checks are`
      : `<code>${checkName}</code> check is`;

  const commentGate =
    cfg.minPrComments > 0
      ? `requires ${cfg.minPrComments} comment${cfg.minPrComments === 1 ? '' : 's'} from someone
      other than the PR author — posted as the <code>${escapeHtml(cfg.commentCheckName)}</code> check`
      : '<span class="muted">disabled (MIN_PR_COMMENTS=0)</span>';

  const c = snap.poll.lastCounters;
  const coverage = c
    ? `<p class="muted" style="margin-top:0.9rem">Last cycle covered:</p>
<div class="stats">
  ${stat(c.installations, 'org installations')}
  ${stat(c.rulesets, `<code>${prefix}*</code> rulesets`)}
  ${stat(c.repos_scanned, 'repos scanned')}
  ${stat(c.repos_pruned, 'repos pruned (out of scope)')}
  ${stat(c.prs, 'open PRs evaluated')}
  ${stat(c.jira_fetches, 'Jira lookups')}
</div>`
    : '';

  const locks = liveLocks(snap, cfg.pollIntervalSeconds, now);
  const github = componentWord(snap.github);
  const jira = componentWord(snap.jira);
  const poll = pollWord(snap.poll.state);
  const vitals = `<div class="vitals">
${vital('#github', 'GitHub', github.dot, github.word, `<code>${escapeHtml(githubApiTarget(cfg))}</code>`)}
${vital('#jira', 'Jira', jira.dot, jira.word, `<code>${escapeHtml(cfg.jira.baseUrl)}</code>`)}
${vital(
    '#polling',
    'Last poll cycle',
    poll.dot,
    poll.word,
    snap.poll.state === 'ok'
      ? `took ${escapeHtml(fmtDuration(snap.poll.lastDurationMs))}`
      : escapeHtml(schedule),
  )}
${vital(
    '#pulls',
    'Merge locks',
    locks.length > 0 ? 'bad' : 'ok',
    `${locks.length} blocked`,
    'pull requests currently held',
  )}
</div>`;

  const body = `${vitals}

<section class="card" id="github">
<div class="card-head"><h2>GitHub</h2>${stateBadge(snap.github)}</div>
<dl class="rows">
  <dt>API target</dt><dd><code>${escapeHtml(githubApiTarget(cfg))}</code></dd>
  <dt>Last success</dt><dd>${fmtWhen(snap.github.lastOkAt, now)}</dd>
  <dt>Last failure</dt><dd>${failureCell(snap.github, now)}</dd>
  <dt>Last webhook</dt><dd>${webhookCell}</dd>
</dl>
</section>

<section class="card" id="jira">
<div class="card-head"><h2>Jira</h2>${stateBadge(snap.jira)}</div>
<dl class="rows">
  <dt>Base URL</dt><dd><code>${escapeHtml(cfg.jira.baseUrl)}</code></dd>
  <dt>Authentication</dt><dd>${escapeHtml(AUTH_LABEL[cfg.jira.authMethod])}</dd>
  <dt>Last success</dt><dd>${fmtWhen(snap.jira.lastOkAt, now)}</dd>
  <dt>Last failure</dt><dd>${failureCell(snap.jira, now)}</dd>
</dl>
</section>

<section class="card" id="polling">
<div class="card-head"><h2>Background polling &amp; rulesets</h2>${pollBadge(snap.poll.state)}</div>
<dl class="rows">
  <dt>Schedule</dt><dd>${escapeHtml(schedule)}</dd>
  <dt>Last cycle</dt><dd>${pollCycleCell(snap.poll, now)}</dd>
  <dt>Auto-configure</dt><dd>${
    cfg.rulesetAutoconfigure
      ? `enabled — the required ${injectedChecks} injected into every <code>${prefix}*</code> org ruleset`
      : 'disabled — admins maintain the required-check entries in their rulesets by hand'
  }</dd>
  <dt>Comment gate</dt><dd>${commentGate}</dd>
</dl>
${coverage}
</section>

${rulesetsCard(cfg, snap, now)}

${pullRequestsCard(cfg, snap, now)}

<section class="card" id="process">
<div class="card-head"><h2>Process</h2><span class="badge neutral">uptime ${escapeHtml(fmtUptime(now - snap.startedAt))}</span></div>
<dl class="rows">
  <dt>Started</dt><dd>${fmtWhen(snap.startedAt, now)}</dd>
</dl>
</section>

<p class="muted">Failure entries show coarse categories only; full error detail is in the
server logs. Jira connectivity is exercised only when an evaluation actually references
Jira issues, so an old “last success” timestamp on a quiet deployment is not a problem
by itself.</p>`;

  return renderPage({
    title: `${APP_NAME} — status`,
    heading: 'Deployment status',
    tagline: `Live deployment status of this ${APP_NAME} instance — GitHub and Jira connectivity,
ruleset coverage, and the pull requests it currently holds.`,
    headerAside: `<span class="badge overall ${OVERALL_CLASS[overall]}">${OVERALL_LABEL[overall]}</span>
<span class="live"><span class="live-dot"></span>auto-refreshes every 10 seconds · <a href="/status.json">JSON</a></span>`,
    nav: [
      { href: '#github', label: 'GitHub' },
      { href: '#jira', label: 'Jira' },
      { href: '#polling', label: 'Polling' },
      { href: '#rulesets', label: 'Rulesets' },
      { href: '#pulls', label: 'Pull requests' },
      { href: '#process', label: 'Process' },
    ],
    extraHead: `<meta http-equiv="refresh" content="10">\n`,
    extraCss: `
  .live a { color: var(--band-muted); }
  .vitals { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: 0.8rem; margin: 0.2rem 0 1.2rem; }
  a.vital {
    display: block; text-decoration: none; color: inherit;
    background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
    padding: 0.8rem 1rem 0.9rem; box-shadow: var(--shadow);
  }
  a.vital:hover { border-color: var(--accent); }
  .vital .vlabel { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.09em; color: var(--muted); margin-bottom: 0.4rem; }
  .vital .vvalue { font-size: 1rem; font-weight: 700; display: flex; align-items: center; gap: 0.5rem; }
  .vital .vsub { color: var(--muted); font-size: 0.78rem; margin-top: 0.3rem; overflow-wrap: anywhere; }
  .vital .vsub code { background: none; padding: 0; color: inherit; }
  .dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; display: inline-block; flex: none; }
  .dot.ok { background: var(--ok); }
  .dot.bad { background: var(--bad); }
  .dot.neutral { background: var(--muted); }
  dl.rows { display: grid; grid-template-columns: 10.5rem 1fr; row-gap: 0.5rem; column-gap: 1rem; margin: 0; }
  dl.rows dt { font-weight: 600; color: var(--muted); font-size: 0.9em; padding-top: 0.12em; }
  dl.rows dd { margin: 0; overflow-wrap: anywhere; }
  @media (max-width: 560px) {
    dl.rows { grid-template-columns: 1fr; row-gap: 0.1rem; }
    dl.rows dd { margin-bottom: 0.6rem; }
  }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: 0.6rem; }
  .stat { background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 0.55rem 0.75rem; }
  .stat .num { font-size: 1.35rem; font-weight: 700; line-height: 1.25; }
  .stat .label { color: var(--muted); font-size: 0.78rem; line-height: 1.35; }
  section.card h3 { font-size: 0.78rem; margin: 1.1rem 0 0.4rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.07em; }
  section.card h3:first-of-type { margin-top: 0.2rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.92em; }
  th { text-align: left; color: var(--muted); font-weight: 600; padding: 0.3rem 0.7rem 0.3rem 0; border-bottom: 1px solid var(--border); white-space: nowrap; }
  td { padding: 0.4rem 0.7rem 0.4rem 0; border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; }
  tbody tr:last-child td { border-bottom: none; }
`,
    body,
  });
}

export function buildStatusJson(
  cfg: AppConfig,
  snap: StatusSnapshot,
  now: number = Date.now(),
): Record<string, unknown> {
  const iso = (ts: number | null): string | null => (ts === null ? null : new Date(ts).toISOString());
  return {
    overall: deriveOverall(snap, cfg.pollIntervalSeconds, now),
    startedAt: iso(snap.startedAt),
    uptimeSeconds: Math.max(0, Math.floor((now - snap.startedAt) / 1000)),
    github: {
      baseUrl: githubApiTarget(cfg),
      state: snap.github.state,
      lastOkAt: iso(snap.github.lastOkAt),
      lastFailAt: iso(snap.github.lastFailAt),
      lastFailReason: snap.github.lastFailReason,
      lastWebhook: { event: snap.webhook.lastEvent, at: iso(snap.webhook.lastAt) },
    },
    jira: {
      baseUrl: cfg.jira.baseUrl,
      authMethod: cfg.jira.authMethod,
      state: snap.jira.state,
      lastOkAt: iso(snap.jira.lastOkAt),
      lastFailAt: iso(snap.jira.lastFailAt),
      lastFailReason: snap.jira.lastFailReason,
    },
    poll: {
      intervalSeconds: cfg.pollIntervalSeconds,
      state: snap.poll.state,
      lastStartedAt: iso(snap.poll.lastStartedAt),
      lastCompletedAt: iso(snap.poll.lastCompletedAt),
      lastDurationMs: snap.poll.lastDurationMs,
      lastCounters: snap.poll.lastCounters,
      lastFailAt: iso(snap.poll.lastFailAt),
      lastFailReason: snap.poll.lastFailReason,
    },
    rulesets: snap.rulesets.map((o) => ({
      org: o.org,
      seenAt: iso(o.seenAt),
      rulesets: o.rulesets,
    })),
    pullRequests: {
      blocked: liveLocks(snap, cfg.pollIntervalSeconds, now).map((e) => ({
        repo: `${e.owner}/${e.repo}`,
        number: e.pullNumber,
        check: e.check,
        title: e.title,
        lastCheckedAt: iso(e.at),
      })),
      recentEvaluations: snap.recentEvaluations.map((e) => ({
        repo: `${e.owner}/${e.repo}`,
        number: e.pullNumber,
        check: e.check,
        trigger: e.trigger,
        conclusion: e.conclusion,
        title: e.title,
        at: iso(e.at),
      })),
    },
    settings: {
      checkName: cfg.checkName,
      rulesetNamePrefix: cfg.rulesetNamePrefix,
      rulesetAutoconfigure: cfg.rulesetAutoconfigure,
      requireIssueKey: cfg.requireIssueKey,
      minPrComments: cfg.minPrComments,
      commentCheckName: cfg.minPrComments > 0 ? cfg.commentCheckName : null,
      doneStatuses: cfg.doneStatuses,
      doneUseCategory: cfg.doneUseCategory,
      projectKeys: cfg.projectKeys,
      pollConcurrency: cfg.pollConcurrency,
    },
  };
}
