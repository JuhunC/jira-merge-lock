import type { AppConfig } from './config.js';
import { escapeHtml } from './homepage.js';
import {
  deriveOverall,
  type ComponentHealth,
  type StatusSnapshot,
} from './status.js';
import type { JiraAuthMethod } from './types.js';

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
  return `${fmtAgo(now - ts)} (${new Date(ts).toISOString()})`;
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

/** "connected · last success 12 s ago (…) · last failure never" */
function connectionCell(c: ComponentHealth, now: number): string {
  const parts: string[] = [];
  switch (c.state) {
    case 'pending':
      parts.push(badge('neutral', 'not yet attempted'));
      break;
    case 'ok':
      parts.push(badge('ok', 'connected'));
      break;
    case 'failed':
      parts.push(badge('bad', 'failing'));
      break;
  }
  if (c.lastOkAt !== null) parts.push(`last success ${fmtWhen(c.lastOkAt, now)}`);
  if (c.lastFailAt !== null) {
    const reason = c.lastFailReason ? ` — ${escapeHtml(c.lastFailReason)}` : '';
    parts.push(`last failure ${fmtWhen(c.lastFailAt, now)}${reason}`);
  }
  return parts.join(' · ');
}

function pollCell(snap: StatusSnapshot, now: number): string {
  const poll = snap.poll;
  const parts: string[] = [];
  switch (poll.state) {
    case 'pending':
      parts.push(badge('neutral', 'no cycle has run yet'));
      break;
    case 'running':
      parts.push(badge('neutral', 'running'), `started ${fmtWhen(poll.lastStartedAt, now)}`);
      break;
    case 'ok':
      parts.push(
        badge('ok', 'succeeded'),
        `completed ${fmtWhen(poll.lastCompletedAt, now)}`,
        `took ${fmtDuration(poll.lastDurationMs)}`,
      );
      break;
    case 'failed': {
      const reason = poll.lastFailReason ? ` — ${escapeHtml(poll.lastFailReason)}` : '';
      parts.push(badge('bad', 'failed'), `${fmtWhen(poll.lastFailAt, now)}${reason}`);
      if (poll.lastCompletedAt !== null) {
        parts.push(`last successful cycle ${fmtWhen(poll.lastCompletedAt, now)}`);
      }
      break;
    }
  }
  return parts.join(' · ');
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
      ? `${badge('neutral', 'none since startup')} · GitHub sends events only when something changes — a quiet period is normal`
      : `<code>${escapeHtml(snap.webhook.lastEvent ?? '')}</code> · ${fmtWhen(snap.webhook.lastAt, now)}`;

  const schedule =
    cfg.pollIntervalSeconds > 0
      ? `every ${cfg.pollIntervalSeconds} seconds (±10% jitter), plus one cycle at startup`
      : 'recurring polling disabled — one cycle at startup, then webhook-driven evaluations only';

  const c = snap.poll.lastCounters;
  const coverage = c
    ? `<dt>Last cycle covered</dt>
  <dd>${c.installations} org installation(s) · ${c.rulesets} <code>${prefix}*</code> ruleset(s) discovered ·
      ${c.repos_scanned} repo(s) scanned (${c.repos_pruned} pruned as out of scope) ·
      ${c.prs} open PR(s) evaluated · ${c.jira_fetches} Jira lookup(s)</dd>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>${checkName} — status</title>
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
  dt { font-weight: 600; margin-top: 1rem; }
  dd { margin-left: 0; }
  .badge {
    display: inline-block;
    padding: 0.05em 0.6em;
    border-radius: 999px;
    font-weight: 600;
    font-size: 0.9em;
  }
  .badge.ok { background: #1a7f37; color: #fff; }
  .badge.bad { background: #cf222e; color: #fff; }
  .badge.neutral { background: rgba(128, 128, 128, 0.3); }
  .muted { opacity: 0.75; font-size: 0.92em; }
</style>
</head>
<body>
<h1><code>${checkName}</code> — deployment status</h1>
<p>Overall: ${badge(OVERALL_CLASS[overall], OVERALL_LABEL[overall])}</p>
<p class="muted">This page auto-refreshes every 10 seconds. Machine-readable version:
<a href="/status.json">/status.json</a>. Merge-check guidelines: <a href="/">homepage</a>.</p>

<h2>GitHub</h2>
<dl>
  <dt>API target</dt>
  <dd><code>${escapeHtml(githubApiTarget(cfg))}</code></dd>
  <dt>Connection</dt>
  <dd>${connectionCell(snap.github, now)}</dd>
  <dt>Last webhook delivery received</dt>
  <dd>${webhookCell}</dd>
</dl>

<h2>Jira</h2>
<dl>
  <dt>Base URL</dt>
  <dd><code>${escapeHtml(cfg.jira.baseUrl)}</code></dd>
  <dt>Authentication method</dt>
  <dd>${escapeHtml(AUTH_LABEL[cfg.jira.authMethod])}</dd>
  <dt>Connection</dt>
  <dd>${connectionCell(snap.jira, now)}</dd>
</dl>

<h2>Background polling &amp; rulesets</h2>
<dl>
  <dt>Schedule</dt>
  <dd>${escapeHtml(schedule)}</dd>
  <dt>Last poll cycle</dt>
  <dd>${pollCell(snap, now)}</dd>
  ${coverage}
  <dt>Ruleset auto-configure</dt>
  <dd>${
    cfg.rulesetAutoconfigure
      ? `enabled — the required <code>${checkName}</code> check is injected into every <code>${prefix}*</code> org ruleset`
      : 'disabled — admins maintain the required-check entry in their rulesets by hand'
  }</dd>
</dl>

<h2>Process</h2>
<dl>
  <dt>Started</dt>
  <dd>${fmtWhen(snap.startedAt, now)}</dd>
  <dt>Uptime</dt>
  <dd>${fmtUptime(now - snap.startedAt)}</dd>
</dl>

<p class="muted">Failure entries show coarse categories only; full error detail is in the
server logs. Jira connectivity is exercised only when an evaluation actually references
Jira issues, so an old “last success” timestamp on a quiet deployment is not a problem
by itself.</p>
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
      doneStatuses: cfg.doneStatuses,
      doneUseCategory: cfg.doneUseCategory,
      projectKeys: cfg.projectKeys,
      pollConcurrency: cfg.pollConcurrency,
    },
  };
}
