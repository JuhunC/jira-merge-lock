/**
 * In-memory operational status, shared by the GitHub fetch wrapper, the
 * JiraClient, the poller, and the webhook layer, and rendered by /status
 * and /status.json (statuspage.ts).
 *
 * Recording methods are cheap synchronous field writes — safe on hot paths.
 * Failure reasons stored here are SHORT FIXED CATEGORIES composed in this
 * codebase, never raw err.message strings: the status page is as public as
 * the homepage. This deployment deliberately publishes which GitHub/Jira
 * base URLs it talks to (statuspage.ts reads them from config), but nothing
 * else may leak — no credentials, no error payloads.
 */

export type ComponentState = 'pending' | 'ok' | 'failed';

export interface ComponentHealth {
  /** Outcome of the most recent attempt; 'pending' = never attempted. */
  state: ComponentState;
  lastOkAt: number | null;
  lastFailAt: number | null;
  /** Short fixed category (e.g. "unreachable (timeout)"). Never err.message. */
  lastFailReason: string | null;
}

/** Counter names mirror the poll_done log line (snake_case on purpose). */
export interface PollCounters {
  installations: number;
  rulesets: number;
  repos_scanned: number;
  repos_pruned: number;
  prs: number;
  jira_fetches: number;
}

export interface PollHealth {
  state: 'pending' | 'running' | 'ok' | 'failed';
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastDurationMs: number | null;
  lastCounters: PollCounters | null;
  lastFailAt: number | null;
  lastFailReason: string | null;
}

export interface WebhookInfo {
  /** Last delivered event as "<event>.<action>" (or bare event name). */
  lastEvent: string | null;
  lastAt: number | null;
}

export interface StatusSnapshot {
  startedAt: number;
  github: ComponentHealth;
  jira: ComponentHealth;
  webhook: WebhookInfo;
  poll: PollHealth;
}

/** Structural subset of StatusTracker that JiraClient depends on. */
export interface JiraStatusRecorder {
  recordJiraOk(): void;
  recordJiraFailure(reason: string): void;
}

function freshComponent(): ComponentHealth {
  return { state: 'pending', lastOkAt: null, lastFailAt: null, lastFailReason: null };
}

export class StatusTracker implements JiraStatusRecorder {
  readonly startedAt: number;
  private readonly now: () => number;
  private readonly github = freshComponent();
  private readonly jira = freshComponent();
  private webhook: WebhookInfo = { lastEvent: null, lastAt: null };
  private readonly poll: PollHealth = {
    state: 'pending',
    lastStartedAt: null,
    lastCompletedAt: null,
    lastDurationMs: null,
    lastCounters: null,
    lastFailAt: null,
    lastFailReason: null,
  };

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.startedAt = now();
  }

  recordGithubOk(): void {
    this.github.state = 'ok';
    this.github.lastOkAt = this.now();
  }

  recordGithubFailure(reason: string): void {
    this.github.state = 'failed';
    this.github.lastFailAt = this.now();
    this.github.lastFailReason = reason;
  }

  recordJiraOk(): void {
    this.jira.state = 'ok';
    this.jira.lastOkAt = this.now();
  }

  recordJiraFailure(reason: string): void {
    this.jira.state = 'failed';
    this.jira.lastFailAt = this.now();
    this.jira.lastFailReason = reason;
  }

  recordWebhook(event: string): void {
    this.webhook = { lastEvent: event, lastAt: this.now() };
  }

  recordPollStarted(): void {
    this.poll.state = 'running';
    this.poll.lastStartedAt = this.now();
  }

  recordPollCompleted(counters: PollCounters, durationMs: number): void {
    this.poll.state = 'ok';
    this.poll.lastCompletedAt = this.now();
    this.poll.lastDurationMs = durationMs;
    this.poll.lastCounters = { ...counters };
  }

  recordPollFailed(reason: string): void {
    this.poll.state = 'failed';
    this.poll.lastFailAt = this.now();
    this.poll.lastFailReason = reason;
  }

  /** Detached copy — render code may not mutate tracker state through it. */
  snapshot(): StatusSnapshot {
    return {
      startedAt: this.startedAt,
      github: { ...this.github },
      jira: { ...this.jira },
      webhook: { ...this.webhook },
      poll: {
        ...this.poll,
        lastCounters: this.poll.lastCounters ? { ...this.poll.lastCounters } : null,
      },
    };
  }
}

/** A cycle running longer than this counts as stuck (the poller's own
 * watchdog warns every 5 minutes; degrade the page well after the first warn). */
const POLL_STUCK_MS = 15 * 60_000;

export type OverallState = 'starting' | 'ok' | 'degraded';

export function deriveOverall(
  snap: StatusSnapshot,
  pollIntervalSeconds: number,
  now: number,
): OverallState {
  if (
    snap.github.state === 'failed' ||
    snap.jira.state === 'failed' ||
    snap.poll.state === 'failed'
  ) {
    return 'degraded';
  }
  const runningMs =
    snap.poll.state === 'running' && snap.poll.lastStartedAt !== null
      ? now - snap.poll.lastStartedAt
      : null;
  if (runningMs !== null && runningMs > POLL_STUCK_MS) return 'degraded';
  // Recurring cycles stopped arriving (only meaningful when polling is on and
  // no cycle is currently in flight).
  if (
    pollIntervalSeconds > 0 &&
    runningMs === null &&
    snap.poll.lastCompletedAt !== null &&
    now - snap.poll.lastCompletedAt > 3 * pollIntervalSeconds * 1000 + 60_000
  ) {
    return 'degraded';
  }
  if (snap.github.state === 'pending' || snap.jira.state === 'pending') return 'starting';
  return 'ok';
}

/** Wrap the GitHub fetch so every API round-trip feeds /status: any HTTP
 * response proves GitHub is reachable (401 = reachable but the app
 * credentials are rejected; 5xx = reachable but erroring); a rejected fetch
 * means timeout / network failure. Reasons are fixed categories — the
 * underlying error detail stays in the logs of whichever caller throws. */
export function makeRecordingFetch(status: StatusTracker, fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    let res: Response;
    try {
      res = await fetchImpl(input, init);
    } catch (err) {
      status.recordGithubFailure('request timed out or network unreachable');
      throw err;
    }
    if (res.status === 401) {
      status.recordGithubFailure('authentication rejected (401) — check app id / private key');
    } else if (res.status >= 500) {
      status.recordGithubFailure(`server error (HTTP ${res.status})`);
    } else {
      status.recordGithubOk();
    }
    return res;
  };
}
