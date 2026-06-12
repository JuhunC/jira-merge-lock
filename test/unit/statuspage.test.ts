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
    expect(html).toContain('merge-lock');
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
      '<div class="num">3</div><div class="label"><code>merge-lock*</code> rulesets</div>',
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
    expect(off).toContain('the required <code>merge-lock/jira-issue</code> check is injected');

    const enabled = loadConfig(testEnv({ MIN_PR_COMMENTS: '2' }));
    const on = renderStatusPage(enabled, tracker.snapshot(), 0);
    expect(on).toContain('requires 2 comments from someone');
    expect(on).toContain('<code>merge-lock/min-comment</code> check');
    expect(on).not.toContain('disabled (MIN_PR_COMMENTS=0)');
    // Auto-configure now lists both injected contexts.
    expect(on).toContain(
      '<code>merge-lock/jira-issue</code> and <code>merge-lock/min-comment</code> checks are injected',
    );
  });

  it('renders the rulesets table with per-check requirement badges', () => {
    const { tracker } = freshSnap(100);
    tracker.recordRulesets('acme', [
      {
        id: 1,
        name: 'merge-lock-main',
        enforcement: 'active',
        requiresJiraCheck: true,
        requiresCommentCheck: false,
      },
      {
        id: 2,
        name: 'merge-lock-release',
        enforcement: 'evaluate',
        requiresJiraCheck: false,
        requiresCommentCheck: false,
      },
    ]);
    const gateOn = loadConfig(testEnv({ MIN_PR_COMMENTS: '1' }));
    const html = renderStatusPage(gateOn, tracker.snapshot(), 1000);
    expect(html).toContain('merge-lock-main');
    expect(html).toContain('merge-lock-release');
    expect(html).toContain('acme');
    expect(html).toContain('2 discovered');
    expect(html).toContain('>active<');
    expect(html).toContain('>evaluate<');
    expect(html).toContain('>required<');
    expect(html).toContain('>missing<');
  });

  it('shows an empty-state hint when no rulesets have been seen', () => {
    const { tracker } = freshSnap();
    const html = renderStatusPage(cfg, tracker.snapshot(), 0);
    expect(html).toContain('0 discovered');
    expect(html).toContain('No <code>merge-lock*</code> rulesets seen yet');
  });

  it('marks a lingering comment-gate entry while the gate is disabled', () => {
    const { tracker } = freshSnap();
    tracker.recordRulesets('acme', [
      {
        id: 1,
        name: 'merge-lock-main',
        enforcement: 'active',
        requiresJiraCheck: true,
        requiresCommentCheck: true,
      },
    ]);
    const html = renderStatusPage(cfg, tracker.snapshot(), 0); // gate off
    expect(html).toContain('still present');
  });

  it('lists currently blocked PRs with links and the recent-evaluations feed', () => {
    const { tracker } = freshSnap(1000);
    tracker.recordEvaluation({
      owner: 'acme',
      repo: 'widgets',
      pullNumber: 7,
      check: 'merge-lock/jira-issue',
      trigger: 'poll',
      conclusion: 'failure',
      title: 'Blocked: 1 of 2 Jira issues not done',
    });
    tracker.recordEvaluation({
      owner: 'acme',
      repo: 'widgets',
      pullNumber: 8,
      check: 'merge-lock/min-comment',
      trigger: 'webhook',
      conclusion: 'success',
      title: 'Discussion requirement met (≥1 comment from others)',
    });
    const html = renderStatusPage(cfg, tracker.snapshot(), 2000);
    expect(html).toContain('1 merge blocked');
    expect(html).toContain('https://github.com/acme/widgets/pull/7');
    expect(html).toContain('Blocked: 1 of 2 Jira issues not done');
    expect(html).toContain('acme/widgets#8'); // feed entry
    expect(html).toContain('>pass<');
    expect(html).toContain('>blocked<');

    // GHES web base: API root minus /api/v3.
    const ghe = loadConfig(testEnv({ GHE_HOST: 'github.yourco.com' }));
    expect(renderStatusPage(ghe, tracker.snapshot(), 2000)).toContain(
      'https://github.yourco.com/acme/widgets/pull/7',
    );
  });

  it('shows the no-blocked-PRs state when everything passes', () => {
    const { tracker } = freshSnap();
    const html = renderStatusPage(cfg, tracker.snapshot(), 0);
    expect(html).toContain('no merges blocked');
    expect(html).toContain('No evaluations yet');
  });

  it('escapes ruleset and PR data', () => {
    const { tracker } = freshSnap();
    tracker.recordRulesets('acme', [
      {
        id: 1,
        name: '<img src=x>merge-lock',
        enforcement: 'active',
        requiresJiraCheck: true,
        requiresCommentCheck: false,
      },
    ]);
    tracker.recordEvaluation({
      owner: 'acme',
      repo: 'widgets',
      pullNumber: 9,
      check: 'merge-lock/jira-issue',
      trigger: 'poll',
      conclusion: 'failure',
      title: '<script>alert(1)</script>',
    });
    const html = renderStatusPage(cfg, tracker.snapshot(), 0);
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toContain('<script>alert');
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
      settings: { checkName: 'merge-lock/jira-issue', rulesetNamePrefix: 'merge-lock' },
    });
    const text = JSON.stringify(json);
    for (const secret of ['test-secret', 'token-123', 'bot@example.com', 'BEGIN RSA', '12345']) {
      expect(text).not.toContain(secret);
    }
    // Timestamps serialize as ISO strings.
    expect((json as any).github.lastOkAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('exposes rulesets and pull-request state', () => {
    const { tracker } = freshSnap();
    tracker.recordRulesets('acme', [
      {
        id: 9,
        name: 'merge-lock-main',
        enforcement: 'active',
        requiresJiraCheck: true,
        requiresCommentCheck: false,
      },
    ]);
    tracker.recordEvaluation({
      owner: 'acme',
      repo: 'widgets',
      pullNumber: 7,
      check: 'merge-lock/jira-issue',
      trigger: 'webhook',
      conclusion: 'failure',
      title: 'Blocked: 1 of 1 Jira issues not done',
    });
    const json = buildStatusJson(cfg, tracker.snapshot(), 1000) as any;
    expect(json.rulesets).toEqual([
      {
        org: 'acme',
        seenAt: '1970-01-01T00:00:00.000Z',
        rulesets: [
          {
            id: 9,
            name: 'merge-lock-main',
            enforcement: 'active',
            requiresJiraCheck: true,
            requiresCommentCheck: false,
          },
        ],
      },
    ]);
    expect(json.pullRequests.blocked).toEqual([
      {
        repo: 'acme/widgets',
        number: 7,
        check: 'merge-lock/jira-issue',
        title: 'Blocked: 1 of 1 Jira issues not done',
        lastCheckedAt: '1970-01-01T00:00:00.000Z',
      },
    ]);
    expect(json.pullRequests.recentEvaluations).toHaveLength(1);
    expect(json.pullRequests.recentEvaluations[0]).toMatchObject({
      conclusion: 'failure',
      trigger: 'webhook',
    });
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
