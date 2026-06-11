import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import nock from 'nock';
import { Probot, ProbotOctokit } from 'probot';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, testEnv } from '../../src/config.js';
import { buildVerdictFromOutcomes } from '../../src/evaluate.js';
import { makeApp } from '../../src/index.js';
import type { JiraIssueOutcome } from '../../src/types.js';

const GH = 'https://api.github.com';
const JIRA = 'https://jira.example.com';
const OWNER = 'acme';
const REPO = 'widgets';
const HEAD_SHA = '1111111111111111111111111111111111111111';
const SYNC_HEAD_SHA = '3333333333333333333333333333333333333333';
const BASE_SHA = '2222222222222222222222222222222222222222';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const cfg = loadConfig(testEnv({ POLL_INTERVAL_SECONDS: '0' }));

function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
}

async function makeProbot(): Promise<Probot> {
  const probot = new Probot({
    appId: 12345,
    privateKey: PRIVATE_KEY,
    logLevel: 'fatal',
    Octokit: ProbotOctokit.defaults({
      retry: { enabled: false },
      throttle: { enabled: false },
    }),
  });
  await probot.load(makeApp(cfg));
  return probot;
}

const IN_SCOPE_RULES = [
  {
    type: 'required_status_checks',
    ruleset_id: 2,
    parameters: {
      strict_required_status_checks_policy: false,
      required_status_checks: [{ context: 'jira-merge-lock', integration_id: 12345 }],
    },
  },
];

const OUT_OF_SCOPE_RULES = [
  {
    type: 'required_status_checks',
    ruleset_id: 77,
    parameters: {
      strict_required_status_checks_policy: false,
      required_status_checks: [{ context: 'ci/build' }],
    },
  },
];

function nockToken(): nock.Scope {
  return nock(GH)
    .post('/app/installations/2/access_tokens')
    .reply(201, { token: 'test', permissions: {} });
}

function nockBranchRules(rules: unknown[]): nock.Scope {
  return nock(GH).get(`/repos/${OWNER}/${REPO}/rules/branches/main`).query(true).reply(200, rules);
}

function nockCommits(messages: string[]): nock.Scope {
  return nock(GH)
    .get(`/repos/${OWNER}/${REPO}/pulls/7/commits`)
    .query(true)
    .reply(
      200,
      messages.map((message, i) => ({ sha: `commitsha${i}`, commit: { message } })),
    );
}

function nockCheckRunsRead(sha: string, runs: unknown[]): nock.Scope {
  return nock(GH)
    .get(`/repos/${OWNER}/${REPO}/commits/${sha}/check-runs`)
    .query(true)
    .reply(200, { total_count: runs.length, check_runs: runs });
}

function nockCheckRunPost(capture: (body: any) => void): nock.Scope {
  return nock(GH)
    .post(`/repos/${OWNER}/${REPO}/check-runs`, (body) => {
      capture(body);
      return true;
    })
    .reply(201, { id: 1 });
}

function nockJiraIssue(key: string, statusName: string, categoryKey: string): nock.Scope {
  return nock(JIRA)
    .get(`/rest/api/2/issue/${key}`)
    .query({ fields: 'status' })
    .reply(200, { key, fields: { status: { name: statusName, statusCategory: { key: categoryKey } } } });
}

beforeEach(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe('pull_request webhook evaluation', () => {
  it('posts a failure check run when a referenced issue is not done', async () => {
    const probot = await makeProbot();
    nockToken();
    nockBranchRules(IN_SCOPE_RULES);
    nockCommits(['PRJ-1: flux phase one', 'PRJ-2: flux phase two']);
    nockJiraIssue('PRJ-1', 'In Progress', 'indeterminate');
    nockJiraIssue('PRJ-2', 'Closed', 'done');
    nockCheckRunsRead(HEAD_SHA, []);
    let body: any;
    const post = nockCheckRunPost((b) => {
      body = b;
    });

    await probot.receive({
      name: 'pull_request',
      id: 'evt-a',
      payload: fixture('pull_request.opened.json'),
    } as any);

    expect(post.isDone()).toBe(true);
    expect(body.name).toBe('jira-merge-lock');
    expect(body.head_sha).toBe(HEAD_SHA);
    expect(body.status).toBe('completed');
    expect(body.conclusion).toBe('failure');
    expect(body.external_id).toMatch(/^[0-9a-f]{64}$/);
    expect(body.output.title).toBe('Blocked: 1 of 2 Jira issues not done');
    expect(body.output.summary).toContain('PRJ-1');
    expect(body.output.summary).toContain('In Progress');
  });

  it('posts a success check run when every referenced issue is done (synchronize)', async () => {
    const probot = await makeProbot();
    nockToken();
    nockBranchRules(IN_SCOPE_RULES);
    nockCommits(['PRJ-1: flux phase one', 'PRJ-2: flux phase two']);
    nockJiraIssue('PRJ-1', 'Closed', 'done');
    nockJiraIssue('PRJ-2', 'Resolved', 'done');
    nockCheckRunsRead(SYNC_HEAD_SHA, []);
    let body: any;
    const post = nockCheckRunPost((b) => {
      body = b;
    });

    await probot.receive({
      name: 'pull_request',
      id: 'evt-b',
      payload: fixture('pull_request.synchronize.json'),
    } as any);

    expect(post.isDone()).toBe(true);
    expect(body.head_sha).toBe(SYNC_HEAD_SHA);
    expect(body.conclusion).toBe('success');
    expect(body.output.title).toBe('All 2 Jira issues done');
  });

  it('out-of-scope base branch: no check run is posted', async () => {
    const probot = await makeProbot();
    nockToken();
    nockBranchRules(OUT_OF_SCOPE_RULES);
    // postSkippedRun reads the latest run; none exists -> noop, never POST.
    nockCheckRunsRead(HEAD_SHA, []);
    const post = nockCheckRunPost(() => {});

    await probot.receive({
      name: 'pull_request',
      id: 'evt-c',
      payload: fixture('pull_request.opened.json'),
    } as any);

    expect(post.isDone()).toBe(false);
  });

  it('matching fingerprint on the latest run: no write', async () => {
    const probot = await makeProbot();
    const outcomes: JiraIssueOutcome[] = [
      { key: 'PRJ-1', outcome: 'found', statusName: 'Closed', statusCategoryKey: 'done' },
      { key: 'PRJ-2', outcome: 'found', statusName: 'Closed', statusCategoryKey: 'done' },
    ];
    const expected = buildVerdictFromOutcomes(outcomes, cfg, { commitCount: 2 });

    nockToken();
    nockBranchRules(IN_SCOPE_RULES);
    nockCommits(['PRJ-1: flux phase one', 'PRJ-2: flux phase two']);
    nockJiraIssue('PRJ-1', 'Closed', 'done');
    nockJiraIssue('PRJ-2', 'Closed', 'done');
    nockCheckRunsRead(HEAD_SHA, [
      { id: 9, external_id: expected.fingerprint, conclusion: 'success' },
    ]);
    const post = nockCheckRunPost(() => {});

    await probot.receive({
      name: 'pull_request',
      id: 'evt-d',
      payload: fixture('pull_request.opened.json'),
    } as any);

    expect(post.isDone()).toBe(false);
  });

  it('Jira outage on a never-verified SHA: posts the fail-closed run', async () => {
    const probot = await makeProbot();
    nockToken();
    nockBranchRules(IN_SCOPE_RULES);
    nockCommits(['PRJ-1: solo change']);
    nock(JIRA).get('/rest/api/2/issue/PRJ-1').query({ fields: 'status' }).reply(500, {});
    nockCheckRunsRead(HEAD_SHA, []);
    let body: any;
    const post = nockCheckRunPost((b) => {
      body = b;
    });

    await probot.receive({
      name: 'pull_request',
      id: 'evt-e1',
      payload: fixture('pull_request.opened.json'),
    } as any);

    expect(post.isDone()).toBe(true);
    expect(body.conclusion).toBe('failure');
    expect(body.output.title).toBe('Jira unreachable — cannot verify referenced issues');
    expect(body.external_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('Jira outage with an existing run on the SHA: keeps the last verdict, no write', async () => {
    const probot = await makeProbot();
    nockToken();
    nockBranchRules(IN_SCOPE_RULES);
    nockCommits(['PRJ-1: solo change']);
    nock(JIRA).get('/rest/api/2/issue/PRJ-1').query({ fields: 'status' }).reply(500, {});
    nockCheckRunsRead(HEAD_SHA, [
      { id: 9, external_id: 'previous-fingerprint', conclusion: 'failure' },
    ]);
    const post = nockCheckRunPost(() => {});

    await probot.receive({
      name: 'pull_request',
      id: 'evt-e2',
      payload: fixture('pull_request.opened.json'),
    } as any);

    expect(post.isDone()).toBe(false);
  });
});

describe('check_run.rerequested', () => {
  it('empty pull_requests[] (fork PR): resolves PRs via the commit and evaluates them', async () => {
    const probot = await makeProbot();
    nockToken();
    const resolvePulls = nock(GH)
      .get(`/repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/pulls`)
      .reply(200, [{ number: 7, head: { sha: HEAD_SHA }, base: { ref: 'main', sha: BASE_SHA } }]);
    nockBranchRules(IN_SCOPE_RULES);
    nockCommits(['PRJ-1: finished work']);
    nockJiraIssue('PRJ-1', 'Closed', 'done');
    nockCheckRunsRead(HEAD_SHA, []);
    let body: any;
    const post = nockCheckRunPost((b) => {
      body = b;
    });

    await probot.receive({
      name: 'check_run',
      id: 'evt-f',
      payload: fixture('check_run.rerequested.json'),
    } as any);

    expect(resolvePulls.isDone()).toBe(true);
    expect(post.isDone()).toBe(true);
    expect(body.head_sha).toBe(HEAD_SHA);
    expect(body.conclusion).toBe('success');
    expect(body.output.title).toBe('All 1 Jira issues done');
  });
});
