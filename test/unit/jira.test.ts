import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, testEnv } from '../../src/config.js';
import { authHeader, JiraClient } from '../../src/jira.js';
import { JiraAuthError, JiraUnavailableError } from '../../src/types.js';
import type { JiraCycleCache, JiraIssueOutcome } from '../../src/types.js';

const BASE = 'https://jira.example.com';
const CLOUD_AUTH = 'Basic Ym90QGV4YW1wbGUuY29tOnRva2VuLTEyMw=='; // bot@example.com:token-123
const BASIC_AUTH = 'Basic amlyYWJvdDpodW50ZXIy'; // jirabot:hunter2
const PAT_AUTH = 'Bearer my-pat-token';

const cloudCfg = () => loadConfig(testEnv());
const patCfg = () => loadConfig(testEnv({ JIRA_AUTH_METHOD: 'pat', JIRA_PAT: 'my-pat-token' }));
const basicCfg = () =>
  loadConfig(
    testEnv({ JIRA_AUTH_METHOD: 'basic', JIRA_USERNAME: 'jirabot', JIRA_PASSWORD: 'hunter2' }),
  );

function issueBody(key: string, statusName: string, categoryKey: string | null = 'done') {
  return {
    key,
    fields: {
      status: {
        name: statusName,
        ...(categoryKey === null ? {} : { statusCategory: { key: categoryKey } }),
      },
    },
  };
}

beforeEach(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe('authHeader', () => {
  it('cloud: Basic base64(email:apiToken)', () => {
    expect(authHeader(cloudCfg().jira)).toBe(CLOUD_AUTH);
  });

  it('pat: Bearer <pat>', () => {
    expect(authHeader(patCfg().jira)).toBe(PAT_AUTH);
  });

  it('basic: Basic base64(username:password)', () => {
    expect(authHeader(basicCfg().jira)).toBe(BASIC_AUTH);
  });
});

describe('Authorization header on the wire', () => {
  it.each([
    ['cloud', cloudCfg, CLOUD_AUTH],
    ['pat', patCfg, PAT_AUTH],
    ['basic', basicCfg, BASIC_AUTH],
  ] as const)('%s mode sends the exact header', async (_mode, cfg, header) => {
    const scope = nock(BASE, { reqheaders: { authorization: header } })
      .get('/rest/api/2/myself')
      .reply(200, { name: 'bot' });
    await new JiraClient(cfg()).probe();
    expect(scope.isDone()).toBe(true);
  });
});

describe('getIssueStatuses per-key outcome mapping', () => {
  const client = () => new JiraClient(cloudCfg());

  it('200 with status -> found with name and category key', async () => {
    nock(BASE)
      .get('/rest/api/2/issue/PRJ-1')
      .query({ fields: 'status' })
      .reply(200, issueBody('PRJ-1', 'In Progress', 'indeterminate'));
    const [outcome] = await client().getIssueStatuses(['PRJ-1']);
    expect(outcome).toEqual({
      key: 'PRJ-1',
      outcome: 'found',
      statusName: 'In Progress',
      statusCategoryKey: 'indeterminate',
    });
  });

  it('200 without statusCategory -> statusCategoryKey null', async () => {
    nock(BASE)
      .get('/rest/api/2/issue/PRJ-2')
      .query({ fields: 'status' })
      .reply(200, issueBody('PRJ-2', 'Closed', null));
    const [outcome] = await client().getIssueStatuses(['PRJ-2']);
    expect(outcome).toEqual({
      key: 'PRJ-2',
      outcome: 'found',
      statusName: 'Closed',
      statusCategoryKey: null,
    });
  });

  it('404 -> not_found', async () => {
    nock(BASE).get('/rest/api/2/issue/UTF-8').query({ fields: 'status' }).reply(404, {});
    const [outcome] = await client().getIssueStatuses(['UTF-8']);
    expect(outcome).toEqual({ key: 'UTF-8', outcome: 'not_found' });
  });

  it('403 -> forbidden', async () => {
    nock(BASE).get('/rest/api/2/issue/SEC-1').query({ fields: 'status' }).reply(403, {});
    const [outcome] = await client().getIssueStatuses(['SEC-1']);
    expect(outcome).toEqual({ key: 'SEC-1', outcome: 'forbidden' });
  });

  it('200 without fields.status -> forbidden', async () => {
    nock(BASE)
      .get('/rest/api/2/issue/SEC-2')
      .query({ fields: 'status' })
      .reply(200, { key: 'SEC-2', fields: {} });
    const [outcome] = await client().getIssueStatuses(['SEC-2']);
    expect(outcome).toEqual({ key: 'SEC-2', outcome: 'forbidden' });
  });

  it('401 -> throws JiraAuthError', async () => {
    nock(BASE).get('/rest/api/2/issue/PRJ-9').query({ fields: 'status' }).reply(401, {});
    await expect(client().getIssueStatuses(['PRJ-9'])).rejects.toBeInstanceOf(JiraAuthError);
  });

  it('429 with Retry-After: 0 retries once then succeeds', async () => {
    const scope = nock(BASE)
      .get('/rest/api/2/issue/PRJ-3')
      .query({ fields: 'status' })
      .reply(429, {}, { 'Retry-After': '0' })
      .get('/rest/api/2/issue/PRJ-3')
      .query({ fields: 'status' })
      .reply(200, issueBody('PRJ-3', 'Resolved'));
    const [outcome] = await client().getIssueStatuses(['PRJ-3']);
    expect(outcome).toMatchObject({ key: 'PRJ-3', outcome: 'found', statusName: 'Resolved' });
    expect(scope.isDone()).toBe(true);
  });

  it('double 429 -> throws JiraUnavailableError(rate_limited)', async () => {
    nock(BASE)
      .get('/rest/api/2/issue/PRJ-4')
      .query({ fields: 'status' })
      .times(2)
      .reply(429, {}, { 'Retry-After': '0' });
    await expect(client().getIssueStatuses(['PRJ-4'])).rejects.toMatchObject({
      name: 'JiraUnavailableError',
      kind: 'rate_limited',
    });
  });

  it('500 -> throws JiraUnavailableError(unreachable)', async () => {
    nock(BASE).get('/rest/api/2/issue/PRJ-5').query({ fields: 'status' }).reply(500, {});
    const err = await client()
      .getIssueStatuses(['PRJ-5'])
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(JiraUnavailableError);
    expect((err as JiraUnavailableError).kind).toBe('unreachable');
  });
});

describe('cycle cache', () => {
  it('pre-populated cache answers without any HTTP', async () => {
    // No nock interceptors are defined and net connect is disabled — any HTTP
    // attempt would reject. Resolution proves the cache short-circuited.
    const cached: JiraIssueOutcome = {
      key: 'PRJ-1',
      outcome: 'found',
      statusName: 'Closed',
      statusCategoryKey: 'done',
    };
    const cache: JiraCycleCache = new Map([['PRJ-1', cached]]);
    const outcomes = await new JiraClient(cloudCfg()).getIssueStatuses(['PRJ-1'], cache);
    expect(outcomes).toEqual([cached]);
  });

  it('fetched outcomes are written back to the cache', async () => {
    nock(BASE)
      .get('/rest/api/2/issue/PRJ-2')
      .query({ fields: 'status' })
      .reply(200, issueBody('PRJ-2', 'Open', 'new'));
    const cache: JiraCycleCache = new Map();
    await new JiraClient(cloudCfg()).getIssueStatuses(['PRJ-2'], cache);
    expect(cache.get('PRJ-2')).toMatchObject({ key: 'PRJ-2', outcome: 'found', statusName: 'Open' });
  });
});

describe('hybrid batch (> 20 uncached keys)', () => {
  const keys = Array.from({ length: 25 }, (_, i) => `PRJ-${i + 1}`);

  it('cloud mode hits bulkfetch once; a missing key gets one per-key follow-up', async () => {
    const scope = nock(BASE)
      .post(
        '/rest/api/3/issue/bulkfetch',
        (body) =>
          Array.isArray(body.issueIdsOrKeys) &&
          body.issueIdsOrKeys.length === 25 &&
          body.issueIdsOrKeys[0] === 'PRJ-1' &&
          JSON.stringify(body.fields) === JSON.stringify(['status']),
      )
      .reply(200, {
        issues: keys.filter((k) => k !== 'PRJ-7').map((k) => issueBody(k, 'Closed', 'done')),
      })
      .get('/rest/api/2/issue/PRJ-7')
      .query({ fields: 'status' })
      .reply(404, {});

    const outcomes = await new JiraClient(cloudCfg()).getIssueStatuses(keys);

    expect(outcomes).toHaveLength(25);
    expect(outcomes.find((o) => o.key === 'PRJ-7')).toEqual({ key: 'PRJ-7', outcome: 'not_found' });
    for (const o of outcomes) {
      if (o.key === 'PRJ-7') continue;
      expect(o).toMatchObject({ outcome: 'found', statusName: 'Closed', statusCategoryKey: 'done' });
    }
    // isDone proves exactly one bulkfetch call and exactly one follow-up GET;
    // any extra request would hit no interceptor and fail under disableNetConnect.
    expect(scope.isDone()).toBe(true);
  });

  it('pat mode uses the search endpoint with a JQL issuekey clause and boolean validateQuery', async () => {
    const scope = nock(BASE, { reqheaders: { authorization: PAT_AUTH } })
      .post(
        '/rest/api/2/search',
        (body) =>
          body.jql === `issuekey in (${keys.join(',')})` &&
          body.maxResults === 100 &&
          // Server/DC types this POST field as boolean — must be exactly false,
          // never the string 'warn' (a Boolean field 400s on a string).
          body.validateQuery === false &&
          JSON.stringify(body.fields) === JSON.stringify(['status']),
      )
      .reply(200, {
        startAt: 0,
        maxResults: 100,
        total: 25,
        issues: keys.map((k) => issueBody(k, 'Resolved', 'done')),
      });

    const outcomes = await new JiraClient(patCfg()).getIssueStatuses(keys);

    expect(outcomes).toHaveLength(25);
    for (const o of outcomes) {
      expect(o).toMatchObject({ outcome: 'found', statusName: 'Resolved' });
    }
    expect(scope.isDone()).toBe(true);
  });

  it('batch 500 falls back to per-key for all keys', async () => {
    const scope = nock(BASE).post('/rest/api/3/issue/bulkfetch').reply(500, {});
    for (const k of keys) {
      scope
        .get(`/rest/api/2/issue/${k}`)
        .query({ fields: 'status' })
        .reply(200, issueBody(k, 'Closed', 'done'));
    }

    const outcomes = await new JiraClient(cloudCfg()).getIssueStatuses(keys);

    expect(outcomes).toHaveLength(25);
    for (const o of outcomes) {
      expect(o).toMatchObject({ outcome: 'found', statusName: 'Closed' });
    }
    expect(scope.isDone()).toBe(true);
  });

  it('batch 401 throws JiraAuthError without per-key fallback', async () => {
    nock(BASE).post('/rest/api/3/issue/bulkfetch').reply(401, {});
    await expect(new JiraClient(cloudCfg()).getIssueStatuses(keys)).rejects.toBeInstanceOf(
      JiraAuthError,
    );
  });
});

describe('strict key gating for batch requests (JQL injection guard)', () => {
  // 22 plain keys plus one underscore-shaped key pin the accepted grammar
  // /^[A-Z][A-Z0-9_]*-\d+$/; 23 safe + 2 odd = 25 keys, above the threshold.
  const safeKeys = [...Array.from({ length: 22 }, (_, i) => `PRJ-${i + 1}`), 'UTF_8-1'];
  const malicious = 'AB-1) OR project=SECRET';
  const lowercase = 'prj-2';
  // Odd keys interleaved mid-list: gating must partition, not truncate.
  const keys = [...safeKeys.slice(0, 5), malicious, ...safeKeys.slice(5), lowercase];

  it('pat mode: odd-shaped keys never appear in the JQL body and resolve per-key', async () => {
    let capturedJql: string | undefined;
    const scope = nock(BASE)
      .post('/rest/api/2/search', (body) => {
        capturedJql = body.jql;
        return true;
      })
      .reply(200, {
        startAt: 0,
        maxResults: 100,
        total: safeKeys.length,
        issues: safeKeys.map((k) => issueBody(k, 'Closed', 'done')),
      })
      .get(`/rest/api/2/issue/${encodeURIComponent(malicious)}`)
      .query({ fields: 'status' })
      .reply(404, {})
      .get(`/rest/api/2/issue/${encodeURIComponent(lowercase)}`)
      .query({ fields: 'status' })
      .reply(404, {});

    const outcomes = await new JiraClient(patCfg()).getIssueStatuses(keys);

    expect(capturedJql).toBe(`issuekey in (${safeKeys.join(',')})`);
    expect(capturedJql).not.toContain('SECRET');
    expect(capturedJql).not.toContain(lowercase);
    expect(outcomes.map((o) => o.key)).toEqual(keys);
    expect(outcomes.find((o) => o.key === malicious)).toEqual({
      key: malicious,
      outcome: 'not_found',
    });
    expect(outcomes.find((o) => o.key === lowercase)).toEqual({
      key: lowercase,
      outcome: 'not_found',
    });
    for (const o of outcomes) {
      if (o.key === malicious || o.key === lowercase) continue;
      expect(o).toMatchObject({ outcome: 'found', statusName: 'Closed' });
    }
    // isDone proves exactly one search call and exactly two per-key GETs; any
    // extra request would hit no interceptor and fail under disableNetConnect.
    expect(scope.isDone()).toBe(true);
  });

  it('cloud mode: odd-shaped keys are excluded from bulkfetch and resolve per-key', async () => {
    let capturedKeys: unknown;
    const scope = nock(BASE)
      .post('/rest/api/3/issue/bulkfetch', (body) => {
        capturedKeys = body.issueIdsOrKeys;
        return true;
      })
      .reply(200, { issues: safeKeys.map((k) => issueBody(k, 'Closed', 'done')) })
      .get(`/rest/api/2/issue/${encodeURIComponent(malicious)}`)
      .query({ fields: 'status' })
      .reply(403, {})
      .get(`/rest/api/2/issue/${encodeURIComponent(lowercase)}`)
      .query({ fields: 'status' })
      .reply(200, issueBody(lowercase, 'Open', 'new'));

    const outcomes = await new JiraClient(cloudCfg()).getIssueStatuses(keys);

    expect(capturedKeys).toEqual(safeKeys);
    expect(outcomes.map((o) => o.key)).toEqual(keys);
    expect(outcomes.find((o) => o.key === malicious)).toEqual({
      key: malicious,
      outcome: 'forbidden',
    });
    expect(outcomes.find((o) => o.key === lowercase)).toMatchObject({
      outcome: 'found',
      statusName: 'Open',
    });
    expect(scope.isDone()).toBe(true);
  });
});

describe('probe', () => {
  it('403 -> JiraAuthError (config failure, not outage)', async () => {
    nock(BASE).get('/rest/api/2/myself').reply(403, {});
    await expect(new JiraClient(cloudCfg()).probe()).rejects.toBeInstanceOf(JiraAuthError);
  });

  it('503 -> JiraUnavailableError', async () => {
    nock(BASE).get('/rest/api/2/myself').reply(503, {});
    await expect(new JiraClient(cloudCfg()).probe()).rejects.toBeInstanceOf(JiraUnavailableError);
  });
});
