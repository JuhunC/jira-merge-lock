import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, testEnv } from '../../src/config.js';
import { makeRoutesHandler, makeStartupProbe, probeFailureReason } from '../../src/main.js';
import type { Readiness } from '../../src/main.js';
import type { LoggerLike } from '../../src/types.js';
import { JiraAuthError, JiraUnavailableError } from '../../src/types.js';

// The Jira host configured by testEnv() — must NEVER appear in any HTTP body
// served by the routes handler (the server is publicly reachable).
const JIRA_HOST = 'jira.example.com';

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

function handlerWith(readiness: Readiness) {
  return makeRoutesHandler(loadConfig(testEnv()), readiness);
}

describe('makeRoutesHandler', () => {
  const ready: Readiness = { ready: true, reason: '' };

  it('GET / -> 200 html with the check name and public max-age=300 caching', () => {
    const handle = handlerWith(ready);
    const { res, rec } = fakeRes();
    expect(handle(fakeReq('GET', '/'), res)).toBe(true);
    expect(rec.status).toBe(200);
    expect(rec.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(rec.headers['cache-control']).toBe('public, max-age=300');
    expect(rec.body).toContain('merge-lock'); // app name + default CHECK_NAME
    expect(rec.body).not.toContain(JIRA_HOST);
    expect(rec.body).not.toContain('test-secret'); // WEBHOOK_SECRET
    expect(rec.body).not.toContain('token-123'); // JIRA_API_TOKEN
  });

  it('GET /?query=string still routes to the homepage', () => {
    const { res, rec } = fakeRes();
    expect(handlerWith(ready)(fakeReq('GET', '/?utm_source=x'), res)).toBe(true);
    expect(rec.status).toBe(200);
  });

  it('GET /healthz -> 200 ok', () => {
    const { res, rec } = fakeRes();
    expect(handlerWith(ready)(fakeReq('GET', '/healthz'), res)).toBe(true);
    expect(rec.status).toBe(200);
    expect(rec.body).toBe('ok');
  });

  it('GET /readyz -> 200 ok when ready', () => {
    const { res, rec } = fakeRes();
    expect(handlerWith(ready)(fakeReq('GET', '/readyz'), res)).toBe(true);
    expect(rec.status).toBe(200);
    expect(rec.body).toBe('ok');
  });

  it('GET /readyz -> 503 with the generic reason when not ready, then 200 after the flip', () => {
    const readiness: Readiness = { ready: false, reason: 'startup probe pending' };
    const handle = handlerWith(readiness);

    const before = fakeRes();
    expect(handle(fakeReq('GET', '/readyz'), before.res)).toBe(true);
    expect(before.rec.status).toBe(503);
    expect(before.rec.body).toBe('startup probe pending');

    readiness.ready = true;
    readiness.reason = '';
    const after = fakeRes();
    expect(handle(fakeReq('GET', '/readyz'), after.res)).toBe(true);
    expect(after.rec.status).toBe(200);
    expect(after.rec.body).toBe('ok');
  });

  it('GET /readyz body never leaks the Jira host on probe failure', () => {
    const cases: Array<{ err: unknown; expected: string }> = [
      {
        err: new JiraAuthError(`Jira rejected credentials on GET https://${JIRA_HOST}/rest/api/2/myself`),
        expected: 'Jira authentication failed — check JIRA_* credentials',
      },
      {
        err: new JiraUnavailableError(`Jira unreachable on GET /rest: getaddrinfo ENOTFOUND ${JIRA_HOST}`, 'timeout'),
        expected: 'Jira unavailable (timeout)',
      },
      {
        err: new JiraUnavailableError(`connect ECONNREFUSED 10.0.0.5:443 (${JIRA_HOST})`, 'unreachable'),
        expected: 'Jira unavailable (unreachable)',
      },
      {
        err: new Error(`TypeError: fetch failed against https://${JIRA_HOST}`),
        expected: 'Jira probe failed',
      },
    ];
    for (const { err, expected } of cases) {
      const readiness: Readiness = { ready: false, reason: probeFailureReason(err) };
      const { res, rec } = fakeRes();
      expect(handlerWith(readiness)(fakeReq('GET', '/readyz'), res)).toBe(true);
      expect(rec.status).toBe(503);
      expect(rec.body).toBe(expected);
      expect(rec.body).not.toContain(JIRA_HOST);
      expect(rec.body).not.toContain('10.0.0.5');
    }
  });

  it('returns false (untouched response) for non-GET methods', () => {
    const handle = handlerWith(ready);
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      for (const path of ['/', '/healthz', '/readyz']) {
        const { res, rec } = fakeRes();
        expect(handle(fakeReq(method, path), res)).toBe(false);
        expect(rec.ended).toBe(false);
      }
    }
  });

  it('returns false for unknown paths', () => {
    const handle = handlerWith(ready);
    for (const path of ['/nope', '/healthz/extra', '/api/github/webhooks']) {
      const { res, rec } = fakeRes();
      expect(handle(fakeReq('GET', path), res)).toBe(false);
      expect(rec.ended).toBe(false);
    }
  });
});

describe('probeFailureReason', () => {
  it('maps every failure to a generic category without err.message', () => {
    expect(probeFailureReason(new JiraAuthError(`401 from ${JIRA_HOST}`))).toBe(
      'Jira authentication failed — check JIRA_* credentials',
    );
    expect(probeFailureReason(new JiraUnavailableError(`down: ${JIRA_HOST}`, 'rate_limited'))).toBe(
      'Jira unavailable (rate_limited)',
    );
    expect(probeFailureReason(new Error(`boom ${JIRA_HOST}`))).toBe('Jira probe failed');
    expect(probeFailureReason('string error')).toBe('Jira probe failed');
  });
});

function silentLog(): LoggerLike {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

describe('makeStartupProbe', () => {
  it('flips readiness on success and schedules nothing', async () => {
    const readiness: Readiness = { ready: false, reason: 'startup probe pending' };
    const retries: Array<() => void> = [];
    const run = makeStartupProbe({
      probe: async () => {},
      readiness,
      log: silentLog(),
      scheduleRetry: (fn) => retries.push(fn),
    });
    await run();
    expect(readiness).toEqual({ ready: true, reason: '' });
    expect(retries).toHaveLength(0);
  });

  it('stops retrying on JiraAuthError (CAPTCHA-lockout protection); reason persists', async () => {
    const readiness: Readiness = { ready: false, reason: 'startup probe pending' };
    const retries: Array<() => void> = [];
    let attempts = 0;
    const run = makeStartupProbe({
      probe: async () => {
        attempts += 1;
        throw new JiraAuthError(`401 from https://${JIRA_HOST}`);
      },
      readiness,
      log: silentLog(),
      scheduleRetry: (fn) => retries.push(fn),
    });
    await run();
    expect(attempts).toBe(1);
    expect(retries).toHaveLength(0); // no retry scheduled — operator must restart
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toBe('Jira authentication failed — check JIRA_* credentials');
    expect(readiness.reason).not.toContain(JIRA_HOST);
  });

  it('retries on JiraUnavailableError and recovers when Jira comes back', async () => {
    const readiness: Readiness = { ready: false, reason: 'startup probe pending' };
    const retries: Array<() => void> = [];
    let attempts = 0;
    const run = makeStartupProbe({
      probe: async () => {
        attempts += 1;
        if (attempts < 3) throw new JiraUnavailableError(`down: ${JIRA_HOST}`, 'timeout');
      },
      readiness,
      log: silentLog(),
      scheduleRetry: (fn) => retries.push(fn),
    });
    await run();
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toBe('Jira unavailable (timeout)');

    retries.shift()?.(); // fire 1st retry (attempt 2 — still failing)
    await new Promise((r) => setImmediate(r));
    expect(readiness.ready).toBe(false);

    retries.shift()?.(); // fire 2nd retry (attempt 3 — succeeds)
    await new Promise((r) => setImmediate(r));
    expect(attempts).toBe(3);
    expect(readiness).toEqual({ ready: true, reason: '' });
    expect(retries).toHaveLength(0);
  });

  it('retries on unexpected errors with a generic reason', async () => {
    const readiness: Readiness = { ready: false, reason: 'startup probe pending' };
    const retries: Array<() => void> = [];
    const run = makeStartupProbe({
      probe: async () => {
        throw new Error(`fetch failed against https://${JIRA_HOST}`);
      },
      readiness,
      log: silentLog(),
      scheduleRetry: (fn) => retries.push(fn),
    });
    await run();
    expect(retries).toHaveLength(1);
    expect(readiness.reason).toBe('Jira probe failed');
    expect(readiness.reason).not.toContain(JIRA_HOST);
  });
});

// Guards for newly added config fields (config.test.ts is owned elsewhere).
describe('config: host and publicUrl', () => {
  it('defaults host to 0.0.0.0', () => {
    expect(loadConfig(testEnv()).host).toBe('0.0.0.0');
  });

  it('normalizes a trailing slash off PUBLIC_URL', () => {
    const cfg = loadConfig(testEnv({ PUBLIC_URL: 'https://merge-lock.example.org/' }));
    expect(cfg.publicUrl).toBe('https://merge-lock.example.org');
  });

  it('leaves publicUrl undefined when PUBLIC_URL is unset', () => {
    expect(loadConfig(testEnv()).publicUrl).toBeUndefined();
  });

  it('rejects an invalid PUBLIC_URL', () => {
    expect(() => loadConfig(testEnv({ PUBLIC_URL: 'not a url' }))).toThrow(ConfigError);
    expect(() => loadConfig(testEnv({ PUBLIC_URL: 'ftp://x.example' }))).toThrow(ConfigError);
  });
});

describe('makeTimeoutFetch', () => {
  it('aborts requests that exceed the timeout', async () => {
    const { makeTimeoutFetch } = await import('../../src/main.js');
    const neverResolves: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
        );
      });
    const wrapped = makeTimeoutFetch(20, neverResolves);
    await expect(wrapped('https://ghe.example.com/api/v3/app')).rejects.toThrow();
  });

  it('combines caller signals with the timeout', async () => {
    const { makeTimeoutFetch } = await import('../../src/main.js');
    let seenSignal: AbortSignal | undefined;
    const impl: typeof fetch = (_input, init) => {
      seenSignal = init?.signal as AbortSignal;
      return Promise.resolve(new Response('ok'));
    };
    const wrapped = makeTimeoutFetch(5_000, impl);
    const caller = new AbortController();
    await wrapped('https://ghe.example.com/api/v3/app', { signal: caller.signal });
    expect(seenSignal).toBeDefined();
    caller.abort();
    expect(seenSignal!.aborted).toBe(true);
  });
});
