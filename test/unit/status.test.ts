import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, testEnv } from '../../src/config.js';
import { makeApp } from '../../src/index.js';
import { JiraClient } from '../../src/jira.js';
import { createPoller } from '../../src/poller.js';
import { ScopeCache } from '../../src/rulesets.js';
import {
  deriveOverall,
  makeRecordingFetch,
  StatusTracker,
  type StatusSnapshot,
} from '../../src/status.js';
import type { LoggerLike } from '../../src/types.js';
import { JiraAuthError, JiraUnavailableError } from '../../src/types.js';

const JIRA_HOST = 'jira.example.com'; // testEnv's Jira host

function silentLog(): LoggerLike {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

/** Tracker with a manual clock. */
function tracked(start = 1_000_000): { tracker: StatusTracker; tick: (ms: number) => void } {
  let now = start;
  return { tracker: new StatusTracker(() => now), tick: (ms) => (now += ms) };
}

describe('StatusTracker', () => {
  it('starts with everything pending and records startedAt', () => {
    const { tracker } = tracked(42);
    const snap = tracker.snapshot();
    expect(snap.startedAt).toBe(42);
    expect(snap.github.state).toBe('pending');
    expect(snap.jira.state).toBe('pending');
    expect(snap.poll.state).toBe('pending');
    expect(snap.webhook).toEqual({ lastEvent: null, lastAt: null });
  });

  it('records component transitions with timestamps and keeps both sides', () => {
    const { tracker, tick } = tracked(1000);
    tracker.recordGithubOk();
    tick(500);
    tracker.recordGithubFailure('server error (HTTP 502)');
    let snap = tracker.snapshot();
    expect(snap.github).toEqual({
      state: 'failed',
      lastOkAt: 1000,
      lastFailAt: 1500,
      lastFailReason: 'server error (HTTP 502)',
    });

    tick(500);
    tracker.recordGithubOk();
    snap = tracker.snapshot();
    expect(snap.github.state).toBe('ok');
    expect(snap.github.lastOkAt).toBe(2000);
    // The old failure stays visible for the page's "last failure" line.
    expect(snap.github.lastFailAt).toBe(1500);
  });

  it('records poll lifecycle: running -> ok with counters, and failed', () => {
    const { tracker, tick } = tracked(0);
    tracker.recordPollStarted();
    expect(tracker.snapshot().poll.state).toBe('running');

    tick(1234);
    const counters = {
      installations: 1,
      rulesets: 2,
      repos_scanned: 3,
      repos_pruned: 4,
      prs: 5,
      jira_fetches: 6,
    };
    tracker.recordPollCompleted(counters, 1234);
    const ok = tracker.snapshot().poll;
    expect(ok).toMatchObject({ state: 'ok', lastCompletedAt: 1234, lastDurationMs: 1234 });
    expect(ok.lastCounters).toEqual(counters);

    tick(100);
    tracker.recordPollFailed('poll cycle failed — see server logs');
    const failed = tracker.snapshot().poll;
    expect(failed.state).toBe('failed');
    expect(failed.lastFailReason).toBe('poll cycle failed — see server logs');
    expect(failed.lastCompletedAt).toBe(1234); // previous success preserved
  });

  it('snapshot returns detached copies', () => {
    const { tracker } = tracked();
    tracker.recordPollCompleted(
      { installations: 1, rulesets: 1, repos_scanned: 1, repos_pruned: 0, prs: 1, jira_fetches: 0 },
      10,
    );
    const snap = tracker.snapshot();
    snap.github.state = 'failed';
    snap.poll.lastCounters!.prs = 999;
    expect(tracker.snapshot().github.state).toBe('pending');
    expect(tracker.snapshot().poll.lastCounters!.prs).toBe(1);
  });
});

describe('deriveOverall', () => {
  const base = (): StatusSnapshot => new StatusTracker(() => 0).snapshot();

  it('is starting until both GitHub and Jira have been attempted', () => {
    const snap = base();
    expect(deriveOverall(snap, 300, 0)).toBe('starting');
    snap.github = { state: 'ok', lastOkAt: 0, lastFailAt: null, lastFailReason: null };
    expect(deriveOverall(snap, 300, 0)).toBe('starting');
    snap.jira = { state: 'ok', lastOkAt: 0, lastFailAt: null, lastFailReason: null };
    expect(deriveOverall(snap, 300, 0)).toBe('ok');
  });

  it('degrades when any component failed', () => {
    for (const component of ['github', 'jira'] as const) {
      const snap = base();
      snap[component].state = 'failed';
      expect(deriveOverall(snap, 300, 0)).toBe('degraded');
    }
    const snap = base();
    snap.poll.state = 'failed';
    expect(deriveOverall(snap, 300, 0)).toBe('degraded');
  });

  it('degrades when a running cycle is stuck, but not while it runs normally', () => {
    const snap = base();
    snap.github.state = 'ok';
    snap.jira.state = 'ok';
    snap.poll.state = 'running';
    snap.poll.lastStartedAt = 0;
    expect(deriveOverall(snap, 300, 60_000)).toBe('ok'); // 1 min in: fine
    expect(deriveOverall(snap, 300, 16 * 60_000)).toBe('degraded'); // 16 min: stuck
  });

  it('degrades when recurring cycles stop arriving (only when polling is on)', () => {
    const snap = base();
    snap.github.state = 'ok';
    snap.jira.state = 'ok';
    snap.poll.state = 'ok';
    snap.poll.lastCompletedAt = 0;
    const overdue = 3 * 300_000 + 61_000;
    expect(deriveOverall(snap, 300, 300_000)).toBe('ok');
    expect(deriveOverall(snap, 300, overdue)).toBe('degraded');
    expect(deriveOverall(snap, 0, overdue)).toBe('ok'); // polling disabled: never overdue
  });
});

describe('makeRecordingFetch', () => {
  it('records ok on 2xx/4xx responses and failure on 401/5xx', async () => {
    const { tracker } = tracked();
    const responses = [200, 404, 401, 502];
    const impl: typeof fetch = async () => new Response('x', { status: responses.shift()! });
    const wrapped = makeRecordingFetch(tracker, impl);

    await wrapped('https://api.github.com/app');
    expect(tracker.snapshot().github.state).toBe('ok');
    await wrapped('https://api.github.com/app'); // 404: reachable + authed
    expect(tracker.snapshot().github.state).toBe('ok');
    await wrapped('https://api.github.com/app'); // 401
    expect(tracker.snapshot().github).toMatchObject({
      state: 'failed',
      lastFailReason: 'authentication rejected (401) — check app id / private key',
    });
    await wrapped('https://api.github.com/app'); // 502
    expect(tracker.snapshot().github.lastFailReason).toBe('server error (HTTP 502)');
  });

  it('records failure and rethrows when the fetch rejects', async () => {
    const { tracker } = tracked();
    const wrapped = makeRecordingFetch(tracker, async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    });
    await expect(wrapped('https://api.github.com/app')).rejects.toThrow('aborted');
    expect(tracker.snapshot().github).toMatchObject({
      state: 'failed',
      lastFailReason: 'request timed out or network unreachable',
    });
  });
});

describe('JiraClient status recording', () => {
  afterEach(() => vi.unstubAllGlobals());

  const cfg = loadConfig(testEnv());

  it('records ok on a successful probe', async () => {
    const { tracker } = tracked();
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
    await new JiraClient(cfg, { status: tracker }).probe();
    expect(tracker.snapshot().jira.state).toBe('ok');
  });

  it('records an auth failure on 401 without leaking the host', async () => {
    const { tracker } = tracked();
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }));
    await expect(new JiraClient(cfg, { status: tracker }).probe()).rejects.toThrow(JiraAuthError);
    const jira = tracker.snapshot().jira;
    expect(jira).toMatchObject({ state: 'failed', lastFailReason: 'authentication rejected (401)' });
    expect(jira.lastFailReason).not.toContain(JIRA_HOST);
  });

  it('records unreachable with the kind category when the fetch rejects', async () => {
    const { tracker } = tracked();
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${JIRA_HOST}`), { name: 'TypeError' });
    });
    await expect(new JiraClient(cfg, { status: tracker }).probe()).rejects.toThrow(
      JiraUnavailableError,
    );
    const jira = tracker.snapshot().jira;
    expect(jira).toMatchObject({ state: 'failed', lastFailReason: 'unreachable (unreachable)' });
    expect(jira.lastFailReason).not.toContain(JIRA_HOST);
  });

  it('records a server error on 5xx', async () => {
    const { tracker } = tracked();
    vi.stubGlobal('fetch', async () => new Response('oops', { status: 503 }));
    await expect(new JiraClient(cfg, { status: tracker }).probe()).rejects.toThrow(
      JiraUnavailableError,
    );
    expect(tracker.snapshot().jira.lastFailReason).toBe('server error (HTTP 503)');
  });
});

describe('poller status recording', () => {
  const cfg = loadConfig(testEnv());

  it('records a completed cycle with counters', async () => {
    const { tracker } = tracked();
    const auth = async () => ({
      paginate: async () => [],
      request: async () => ({ data: {}, status: 200, headers: {} }),
    });
    const poller = createPoller({
      auth: auth as any,
      cfg,
      jira: {} as any,
      scopeCache: new ScopeCache(60_000),
      log: silentLog(),
      status: tracker,
    });
    await poller.runOnce();
    const poll = tracker.snapshot().poll;
    expect(poll.state).toBe('ok');
    expect(poll.lastCounters).toEqual({
      installations: 0,
      rulesets: 0,
      repos_scanned: 0,
      repos_pruned: 0,
      prs: 0,
      jira_fetches: 0,
    });
    expect(typeof poll.lastDurationMs).toBe('number');
  });

  it('records a failed cycle with the fixed public category', async () => {
    const { tracker } = tracked();
    const poller = createPoller({
      auth: async () => {
        throw new Error('GitHub exploded: secret-detail');
      },
      cfg,
      jira: {} as any,
      scopeCache: new ScopeCache(60_000),
      log: silentLog(),
      status: tracker,
    });
    await poller.runOnce();
    const poll = tracker.snapshot().poll;
    expect(poll.state).toBe('failed');
    expect(poll.lastFailReason).toBe('poll cycle failed — see server logs');
    expect(poll.lastFailReason).not.toContain('secret-detail');
  });
});

describe('webhook recording via makeApp', () => {
  it('records "<event>.<action>" through app.onAny', () => {
    const { tracker } = tracked(777);
    let anyHandler: ((event: any) => void) | undefined;
    const app = {
      on() {},
      onAny(fn: (event: any) => void) {
        anyHandler = fn;
      },
      log: silentLog(),
    };
    makeApp(loadConfig(testEnv()), {
      jira: {} as any,
      scopeCache: new ScopeCache(60_000),
      status: tracker,
    })(app);

    expect(anyHandler).toBeDefined();
    anyHandler!({ name: 'pull_request', payload: { action: 'opened' } });
    expect(tracker.snapshot().webhook).toEqual({ lastEvent: 'pull_request.opened', lastAt: 777 });

    anyHandler!({ name: 'ping', payload: {} });
    expect(tracker.snapshot().webhook.lastEvent).toBe('ping');
  });

  it('tolerates fake apps without onAny', () => {
    const app = { on() {}, log: silentLog() };
    expect(() =>
      makeApp(loadConfig(testEnv()), { jira: {} as any, scopeCache: new ScopeCache(1) })(app),
    ).not.toThrow();
  });
});
