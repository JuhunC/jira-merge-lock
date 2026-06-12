import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { loadConfig, testEnv } from '../../src/config.js';
import { makeRoutesHandler, type Readiness } from '../../src/main.js';
import { StatusTracker } from '../../src/status.js';
import { buildStatusJson, renderStatusPage } from '../../src/statuspage.js';

const cfg = loadConfig(testEnv());

function freshSnap(now = 0): { tracker: StatusTracker; now: number } {
  return { tracker: new StatusTracker(() => now), now };
}

describe('renderStatusPage', () => {
  it('returns a complete html document with the check name', () => {
    const { tracker } = freshSnap();
    const html = renderStatusPage(cfg, tracker.snapshot(), 0);
    expect(html.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    expect(html).toContain('jira-merge-lock');
  });

  it('deliberately shows the GitHub and Jira base URLs', () => {
    const { tracker } = freshSnap();
    const html = renderStatusPage(cfg, tracker.snapshot(), 0);
    expect(html).toContain('https://api.github.com');
    expect(html).toContain('https://jira.example.com');

    const ghe = loadConfig(testEnv({ GHE_HOST: 'github.yourco.com' }));
    const gheHtml = renderStatusPage(ghe, tracker.snapshot(), 0);
    expect(gheHtml).toContain('https://github.yourco.com/api/v3');
  });

  it('never shows credentials, the app id, or client JS', () => {
    const { tracker } = freshSnap();
    tracker.recordJiraFailure('authentication rejected (401)');
    const html = renderStatusPage(cfg, tracker.snapshot(), 0);
    for (const secret of ['test-secret', 'token-123', 'bot@example.com', 'BEGIN RSA', '12345']) {
      expect(html).not.toContain(secret);
    }
    expect(html).not.toContain('<script');
  });

  it('shows Starting up before anything is attempted, Operational when healthy', () => {
    const { tracker } = freshSnap();
    expect(renderStatusPage(cfg, tracker.snapshot(), 0)).toContain('Starting up');

    tracker.recordGithubOk();
    tracker.recordJiraOk();
    const html = renderStatusPage(cfg, tracker.snapshot(), 0);
    expect(html).toContain('Operational');
    expect(html).toContain('connected');
  });

  it('shows Degraded and the coarse failure category when a component fails', () => {
    const { tracker } = freshSnap();
    tracker.recordGithubOk();
    tracker.recordJiraFailure('unreachable (timeout)');
    const html = renderStatusPage(cfg, tracker.snapshot(), 0);
    expect(html).toContain('Degraded');
    expect(html).toContain('failing');
    expect(html).toContain('unreachable (timeout)');
  });

  it('shows poll cycle coverage including discovered rulesets', () => {
    const { tracker } = freshSnap();
    tracker.recordPollStarted();
    tracker.recordPollCompleted(
      { installations: 2, rulesets: 3, repos_scanned: 7, repos_pruned: 4, prs: 11, jira_fetches: 5 },
      850,
    );
    const html = renderStatusPage(cfg, tracker.snapshot(), 1000);
    expect(html).toContain('succeeded');
    expect(html).toContain('<div class="num">2</div><div class="label">org installations</div>');
    expect(html).toContain(
      '<div class="num">3</div><div class="label"><code>jira-merge-lock*</code> rulesets</div>',
    );
    expect(html).toContain('<div class="num">7</div><div class="label">repos scanned</div>');
    expect(html).toContain(
      '<div class="num">4</div><div class="label">repos pruned (out of scope)</div>',
    );
    expect(html).toContain('<div class="num">11</div><div class="label">open PRs evaluated</div>');
    expect(html).toContain('<div class="num">5</div><div class="label">Jira lookups</div>');
    expect(html).toContain('850 ms');
  });

  it('shows the comment gate as disabled by default and its policy when enabled', () => {
    const { tracker } = freshSnap();
    const off = renderStatusPage(cfg, tracker.snapshot(), 0);
    expect(off).toContain('disabled (MIN_PR_COMMENTS=0)');
    expect(off).toContain('the required <code>jira-merge-lock</code> check is injected');

    const enabled = loadConfig(testEnv({ MIN_PR_COMMENTS: '2' }));
    const on = renderStatusPage(enabled, tracker.snapshot(), 0);
    expect(on).toContain('requires 2 comments from someone');
    expect(on).toContain('<code>jira-merge-lock-comments</code> check');
    expect(on).not.toContain('disabled (MIN_PR_COMMENTS=0)');
    // Auto-configure now lists both injected contexts.
    expect(on).toContain(
      '<code>jira-merge-lock</code> and <code>jira-merge-lock-comments</code> checks are injected',
    );
  });

  it('shows the last received webhook event', () => {
    const { tracker } = freshSnap(500);
    tracker.recordWebhook('pull_request.opened');
    const html = renderStatusPage(cfg, tracker.snapshot(), 1000);
    expect(html).toContain('pull_request.opened');
  });

  it('html-escapes recorded strings and config values', () => {
    const evil = loadConfig(testEnv({ CHECK_NAME: 'x<img src=x>' }));
    const { tracker } = freshSnap();
    tracker.recordWebhook('<script>alert(1)</script>');
    const html = renderStatusPage(evil, tracker.snapshot(), 0);
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toContain('<script>alert');
  });
});

describe('buildStatusJson', () => {
  it('exposes urls, component states, poll info, and safe settings only', () => {
    const { tracker } = freshSnap();
    tracker.recordGithubOk();
    tracker.recordJiraOk();
    tracker.recordPollCompleted(
      { installations: 1, rulesets: 1, repos_scanned: 1, repos_pruned: 0, prs: 2, jira_fetches: 1 },
      100,
    );
    const json = buildStatusJson(cfg, tracker.snapshot(), 60_000);
    expect(json).toMatchObject({
      overall: 'ok',
      uptimeSeconds: 60,
      github: { baseUrl: 'https://api.github.com', state: 'ok' },
      jira: { baseUrl: 'https://jira.example.com', authMethod: 'cloud', state: 'ok' },
      poll: { intervalSeconds: 300, state: 'ok', lastDurationMs: 100 },
      settings: { checkName: 'jira-merge-lock', rulesetNamePrefix: 'jira-merge-lock' },
    });
    const text = JSON.stringify(json);
    for (const secret of ['test-secret', 'token-123', 'bot@example.com', 'BEGIN RSA', '12345']) {
      expect(text).not.toContain(secret);
    }
    // Timestamps serialize as ISO strings.
    expect((json as any).github.lastOkAt).toBe('1970-01-01T00:00:00.000Z');
  });
});

// --- routes ---------------------------------------------------------------

function fakeReq(method: string, url: string): IncomingMessage {
  return { method, url } as unknown as IncomingMessage;
}

interface RecordedResponse {
  status: number | undefined;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
}

function fakeRes(): { res: ServerResponse; rec: RecordedResponse } {
  const rec: RecordedResponse = { status: undefined, headers: {}, body: '', ended: false };
  const res = {
    writeHead(status: number, headers?: Record<string, string>): unknown {
      rec.status = status;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) rec.headers[k.toLowerCase()] = v;
      }
      return res;
    },
    end(chunk?: unknown): unknown {
      if (typeof chunk === 'string') rec.body += chunk;
      rec.ended = true;
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, rec };
}

describe('GET /status and /status.json routes', () => {
  const readiness: Readiness = { ready: true, reason: '' };

  it('serves the live html page uncached', () => {
    const tracker = new StatusTracker();
    const handle = makeRoutesHandler(cfg, readiness, tracker);
    const { res, rec } = fakeRes();
    expect(handle(fakeReq('GET', '/status'), res)).toBe(true);
    expect(rec.status).toBe(200);
    expect(rec.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(rec.headers['cache-control']).toBe('no-store');
    expect(rec.body).toContain('deployment status');
  });

  it('reflects tracker updates between requests (rendered per request)', () => {
    const tracker = new StatusTracker();
    const handle = makeRoutesHandler(cfg, readiness, tracker);

    const before = fakeRes();
    handle(fakeReq('GET', '/status'), before.res);
    expect(before.rec.body).not.toContain('unreachable (timeout)');

    tracker.recordJiraFailure('unreachable (timeout)');
    const after = fakeRes();
    handle(fakeReq('GET', '/status'), after.res);
    expect(after.rec.body).toContain('unreachable (timeout)');
  });

  it('serves parseable json with no-store', () => {
    const handle = makeRoutesHandler(cfg, readiness, new StatusTracker());
    const { res, rec } = fakeRes();
    expect(handle(fakeReq('GET', '/status.json?x=1'), res)).toBe(true);
    expect(rec.status).toBe(200);
    expect(rec.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(rec.headers['cache-control']).toBe('no-store');
    const parsed = JSON.parse(rec.body);
    expect(parsed.overall).toBe('starting');
    expect(parsed.jira.baseUrl).toBe('https://jira.example.com');
  });

  it('leaves non-GET requests untouched', () => {
    const handle = makeRoutesHandler(cfg, readiness, new StatusTracker());
    for (const path of ['/status', '/status.json']) {
      const { res, rec } = fakeRes();
      expect(handle(fakeReq('POST', path), res)).toBe(false);
      expect(rec.ended).toBe(false);
    }
  });
});
