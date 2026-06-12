import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, testEnv } from '../../src/config.js';
import { makeApp } from '../../src/index.js';
import { JiraClient } from '../../src/jira.js';
import { createPoller } from '../../src/poller.js';
import { ScopeCache } from '../../src/rulesets.js';
import {
  deriveOverall,
  liveLocks,
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

describe('rulesets and evaluation recording', () => {
  const evalBase = {
    owner: 'acme',
    repo: 'widgets',
    pullNumber: 7,
    check: 'merge-lock/jira-issue',
    trigger: 'poll',
    title: 'Blocked: 1 of 1 Jira issues not done',
  } as const;

  it('replaces an org ruleset view wholesale and sorts orgs in the snapshot', () => {
    const { tracker } = tracked(100);
    const rs = (name: string) => ({
      id: 1,
      name,
      enforcement: 'active',
      requiresJiraCheck: true,
      requiresCommentCheck: false,
    });
    tracker.recordRulesets('zeta', [rs('merge-lock-z')]);
    tracker.recordRulesets('acme', [rs('merge-lock-a'), rs('merge-lock-b')]);
    tracker.recordRulesets('zeta', [rs('merge-lock-z2')]); // replaces, not appends
    const snap = tracker.snapshot();
    expect(snap.rulesets.map((o) => o.org)).toEqual(['acme', 'zeta']);
    expect(snap.rulesets[1]!.rulesets.map((r) => r.name)).toEqual(['merge-lock-z2']);
    expect(snap.rulesets[0]!.seenAt).toBe(100);
  });

  it('tracks blocked PRs per (PR, check): failure adds, success removes', () => {
    const { tracker } = tracked();
    tracker.recordEvaluation({ ...evalBase, conclusion: 'failure' });
    tracker.recordEvaluation({
      ...evalBase,
      check: 'merge-lock/min-comment',
      conclusion: 'failure',
      title: 'needs comments',
    });
    expect(tracker.snapshot().lockedPrs).toHaveLength(2);

    tracker.recordEvaluation({ ...evalBase, conclusion: 'success', title: 'all done' });
    const locked = tracker.snapshot().lockedPrs;
    expect(locked).toHaveLength(1);
    expect(locked[0]!.check).toBe('merge-lock/min-comment');
  });

  it('feed:false updates the blocked map without spamming the activity feed', () => {
    const { tracker } = tracked();
    tracker.recordEvaluation({ ...evalBase, conclusion: 'failure' }, { feed: false });
    const snap = tracker.snapshot();
    expect(snap.recentEvaluations).toHaveLength(0);
    expect(snap.lockedPrs).toHaveLength(1);
  });

  it('caps the activity feed at 20 entries, newest first', () => {
    const { tracker, tick } = tracked();
    for (let i = 0; i < 25; i++) {
      tick(1);
      tracker.recordEvaluation({ ...evalBase, pullNumber: i, conclusion: 'success' });
    }
    const recent = tracker.snapshot().recentEvaluations;
    expect(recent).toHaveLength(20);
    expect(recent[0]!.pullNumber).toBe(24);
  });

  it('recordSkipped clears a lock (PR went out of scope)', () => {
    const { tracker } = tracked();
    tracker.recordEvaluation({ ...evalBase, conclusion: 'failure' });
    tracker.recordSkipped({ owner: 'acme', repo: 'widgets', pullNumber: 7, check: evalBase.check });
    expect(tracker.snapshot().lockedPrs).toHaveLength(0);
  });

  it('liveLocks filters entries the poller stopped confirming (closed PRs)', () => {
    const { tracker, tick } = tracked(0);
    tracker.recordEvaluation({ ...evalBase, conclusion: 'failure' });
    tick(1000);
    tracker.recordEvaluation({ ...evalBase, pullNumber: 8, conclusion: 'failure' });
    const snap = tracker.snapshot();
    const interval = 300; // 3*300s + 60s grace = 960_000 ms
    expect(liveLocks(snap, interval, 960_500).map((e) => e.pullNumber)).toEqual([8]);
    expect(liveLocks(snap, interval, 500)).toHaveLength(2);
    // Polling disabled: no refresh authority, keep everything.
    expect(liveLocks(snap, 0, 10_000_000)).toHaveLength(2);
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
