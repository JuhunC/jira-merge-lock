import type { AppConfig } from './config.js';
import {
  deriveOverall,
  type ComponentHealth,
  type StatusSnapshot,
} from './status.js';
import type { JiraAuthMethod } from './types.js';
import { escapeHtml, SHARED_CSS } from './webui.js';

/**
 * Live operational status served at GET /status (HTML, auto-refreshing) and
 * GET /status.json. The page is publicly reachable, like the homepage. It
 * DELIBERATELY shows the configured GitHub and Jira base URLs (a deployment
 * decision — operators who consider those sensitive must front the service
 * with auth), but never credentials, the app id, or raw error messages —
 * only the fixed failure categories recorded in StatusTracker.
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

function stateBadge(c: ComponentHealth): string {
  switch (c.state) {
    case 'pending':
      return badge('neutral', 'not yet attempted');
    case 'ok':
      return badge('ok', 'connected');
    case 'failed':
      return badge('bad', 'failing');
  }
}

function failureCell(c: ComponentHealth, now: number): string {
  if (c.lastFailAt === null) return '<span class="muted">never</span>';
  const reason = c.lastFailReason ? ` — ${escapeHtml(c.lastFailReason)}` : '';
  return `${fmtWhen(c.lastFailAt, now)}${reason}`;
}

function pollBadge(state: StatusSnapshot['poll']['state']): string {
  switch (state) {
    case 'pending':
      return badge('neutral', 'no cycle yet');
    case 'running':
      return badge('neutral', 'running');
    case 'ok':
      return badge('ok', 'succeeded');
    case 'failed':
      return badge('bad', 'failed');
  }
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

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>${checkName} — status</title>
<style>${SHARED_CSS}
  .hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  .hero .subtitle { margin-bottom: 1rem; }
  .badge.overall { font-size: 0.95rem; padding: 0.25em 0.9em; margin-top: 0.3rem; }
  .card-head {
    display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.55rem; margin-bottom: 0.85rem;
  }
  .card-head h2 { font-size: 1.02rem; margin: 0; }
  dl.rows { display: grid; grid-template-columns: 10.5rem 1fr; row-gap: 0.5rem; column-gap: 1rem; margin: 0; }
  dl.rows dt { font-weight: 600; color: var(--muted); font-size: 0.9em; padding-top: 0.12em; }
  dl.rows dd { margin: 0; overflow-wrap: anywhere; }
  @media (max-width: 560px) {
    dl.rows { grid-template-columns: 1fr; row-gap: 0.1rem; }
    dl.rows dd { margin-bottom: 0.6rem; }
  }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: 0.6rem; }
  .stat { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 0.55rem 0.75rem; }
  .stat .num { font-size: 1.35rem; font-weight: 700; line-height: 1.25; }
  .stat .label { color: var(--muted); font-size: 0.78rem; line-height: 1.35; }
</style>
</head>
<body>
<div class="hero">
  <div>
    <h1><code>${checkName}</code> — deployment status</h1>
    <p class="subtitle">Auto-refreshes every 10 seconds · <a href="/status.json">JSON</a> ·
    <a href="/">merge-check guidelines</a></p>
  </div>
  <span class="badge overall ${OVERALL_CLASS[overall]}">${OVERALL_LABEL[overall]}</span>
</div>

<section class="card">
<div class="card-head"><h2>GitHub</h2>${stateBadge(snap.github)}</div>
<dl class="rows">
  <dt>API target</dt><dd><code>${escapeHtml(githubApiTarget(cfg))}</code></dd>
  <dt>Last success</dt><dd>${fmtWhen(snap.github.lastOkAt, now)}</dd>
  <dt>Last failure</dt><dd>${failureCell(snap.github, now)}</dd>
  <dt>Last webhook</dt><dd>${webhookCell}</dd>
</dl>
</section>

<section class="card">
<div class="card-head"><h2>Jira</h2>${stateBadge(snap.jira)}</div>
<dl class="rows">
  <dt>Base URL</dt><dd><code>${escapeHtml(cfg.jira.baseUrl)}</code></dd>
  <dt>Authentication</dt><dd>${escapeHtml(AUTH_LABEL[cfg.jira.authMethod])}</dd>
  <dt>Last success</dt><dd>${fmtWhen(snap.jira.lastOkAt, now)}</dd>
  <dt>Last failure</dt><dd>${failureCell(snap.jira, now)}</dd>
</dl>
</section>

<section class="card">
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

<section class="card">
<div class="card-head"><h2>Process</h2><span class="badge neutral">uptime ${escapeHtml(fmtUptime(now - snap.startedAt))}</span></div>
<dl class="rows">
  <dt>Started</dt><dd>${fmtWhen(snap.startedAt, now)}</dd>
</dl>
</section>

<footer>
<p class="muted">Failure entries show coarse categories only; full error detail is in the
server logs. Jira connectivity is exercised only when an evaluation actually references
Jira issues, so an old “last success” timestamp on a quiet deployment is not a problem
by itself.</p>
</footer>
</body>
</html>
`;
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
