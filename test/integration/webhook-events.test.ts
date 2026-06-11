import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import nock from 'nock';
import { Probot, ProbotOctokit } from 'probot';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, testEnv } from '../../src/config.js';
import { makeApp } from '../../src/index.js';

const GH = 'https://api.github.com';
const JIRA = 'https://jira.example.com';
const OWNER = 'acme';
const REPO = 'widgets';
const HEAD_SHA = '1111111111111111111111111111111111111111';
const BASE_SHA = '2222222222222222222222222222222222222222';
// The merge queue's temporary SHA — deliberately different from the PR head.
const MG_SHA = '4444444444444444444444444444444444444444';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const cfg = loadConfig(testEnv({ POLL_INTERVAL_SECONDS: '0' }));

function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
}

interface LogRecord {
  level: string;
  data: Record<string, unknown>;
  msg?: string;
}

/** Minimal pino-shaped logger that records every call; child() shares the sink. */
function makeRecordingLogger(records: LogRecord[]): any {
  const make = (): any => {
    const logger: any = { child: () => make() };
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      logger[level] = (data?: unknown, msg?: string) => {
        if (typeof data === 'string') {
          records.push({ level, data: {}, msg: data });
        } else {
          records.push({ level, data: (data ?? {}) as Record<string, unknown>, msg });
        }
      };
    }
    return logger;
  };
  return make();
}

async function makeProbot(records?: LogRecord[]): Promise<Probot> {
  const probot = new Probot({
    appId: 12345,
    privateKey: PRIVATE_KEY,
    logLevel: 'fatal',
    ...(records ? { log: makeRecordingLogger(records) } : {}),
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

/** Live evaluations POST an in_progress run first; the reply id feeds the
 * completing PATCH below. */
function nockInProgressPost(capture: (body: any) => void): nock.Scope {
  return nock(GH)
    .post(`/repos/${OWNER}/${REPO}/check-runs`, (body) => {
      capture(body);
      return true;
    })
    .reply(201, { id: 777 });
}

function nockCheckRunPatch(id: number, capture: (body: any) => void): nock.Scope {
  return nock(GH)
    .patch(`/repos/${OWNER}/${REPO}/check-runs/${id}`, (body) => {
      capture(body);
      return true;
    })
    .reply(200, { id });
}

function nockJiraIssue(key: string, statusName: string, categoryKey: string): nock.Scope {
  return nock(JIRA)
    .get(`/rest/api/2/issue/${key}`)
    .query({ fields: 'status' })
    .reply(200, {
      key,
      fields: { status: { name: statusName, statusCategory: { key: categoryKey } } },
    });
}

function nockPullFetch(pullNumber: number): nock.Scope {
  return nock(GH)
    .get(`/repos/${OWNER}/${REPO}/pulls/${pullNumber}`)
    .reply(200, {
      number: pullNumber,
      head: { sha: HEAD_SHA },
      base: { ref: 'main', sha: BASE_SHA },
    });
}

const REPOSITORY = {
  id: 1296269,
  name: REPO,
  full_name: `${OWNER}/${REPO}`,
  private: true,
  owner: { login: OWNER, id: 5001, type: 'Organization' },
  default_branch: 'main',
};

function mergeGroupPayload(headRef: string): any {
  return {
    action: 'checks_requested',
    merge_group: {
      head_sha: MG_SHA,
      head_ref: headRef,
      base_sha: BASE_SHA,
      base_ref: 'refs/heads/main',
    },
    repository: REPOSITORY,
    organization: { login: OWNER, id: 5001 },
    installation: { id: 2 },
    sender: { login: 'octocat', type: 'User' },
  };
}

beforeEach(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe('merge_group.checks_requested', () => {
  it('fetches the PR from head_ref and posts the check on the merge group head SHA', async () => {
    const probot = await makeProbot();
    nockToken();
    const pullFetch = nockPullFetch(7);
    nockBranchRules(IN_SCOPE_RULES);
    nockCommits(['PRJ-1: finished work']);
    nockJiraIssue('PRJ-1', 'Closed', 'done');
    nockCheckRunsRead(MG_SHA, []);
    let inProgress: any;
    const post = nockInProgressPost((b) => {
      inProgress = b;
    });
    let body: any;
    const patch = nockCheckRunPatch(777, (b) => {
      body = b;
    });

    await probot.receive({
      name: 'merge_group',
      id: 'evt-mg-1',
      payload: mergeGroupPayload(`refs/heads/gh-readonly-queue/main/pr-7-${HEAD_SHA}`),
    } as any);

    expect(pullFetch.isDone()).toBe(true);
    expect(post.isDone()).toBe(true);
    // The verdict is computed from the PR but posted on the queue's temp SHA.
    expect(inProgress.head_sha).toBe(MG_SHA);
    expect(inProgress.name).toBe('jira-merge-lock');
    expect(inProgress.status).toBe('in_progress');
    expect(patch.isDone()).toBe(true);
    expect(body.status).toBe('completed');
    expect(body.conclusion).toBe('success');
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('base branch containing "pr-9-": parses the TRAILING pr-<n> segment, not the first', async () => {
    const probot = await makeProbot();
    nockToken();
    // Only PR 7 is nocked: if the handler parsed 9 from the base-branch segment,
    // GET /pulls/9 would hit no interceptor and disableNetConnect would reject.
    const pullFetch = nockPullFetch(7);
    nockBranchRules(IN_SCOPE_RULES);
    nockCommits(['PRJ-1: finished work']);
    nockJiraIssue('PRJ-1', 'Closed', 'done');
    nockCheckRunsRead(MG_SHA, []);
    let inProgress: any;
    const post = nockInProgressPost((b) => {
      inProgress = b;
    });
    const patch = nockCheckRunPatch(777, () => {});

    await probot.receive({
      name: 'merge_group',
      id: 'evt-mg-2',
      payload: mergeGroupPayload(
        `refs/heads/gh-readonly-queue/feature/pr-9-fix/pr-7-${HEAD_SHA}`,
      ),
    } as any);

    expect(pullFetch.isDone()).toBe(true);
    expect(post.isDone()).toBe(true);
    expect(inProgress.head_sha).toBe(MG_SHA);
    expect(patch.isDone()).toBe(true);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('unparseable head_ref: warns and makes no API calls', async () => {
    const records: LogRecord[] = [];
    const probot = await makeProbot(records);

    // Zero interceptors: with disableNetConnect active, ANY call (even the
    // installation token request) would reject the receive below.
    await probot.receive({
      name: 'merge_group',
      id: 'evt-mg-3',
      payload: mergeGroupPayload('refs/heads/gh-readonly-queue/main/not-a-pr-segment'),
    } as any);

    expect(nock.pendingMocks()).toEqual([]);
    const warns = records.filter(
      (r) => r.level === 'warn' && r.data['evt'] === 'merge_group_unparseable',
    );
    expect(warns).toHaveLength(1);
  });
});

describe('pull_request.edited', () => {
  function editedPayload(changes: Record<string, unknown>): any {
    const payload = fixture('pull_request.opened.json');
    payload.action = 'edited';
    payload.changes = changes;
    return payload;
  }

  it('base retarget (changes.base present): re-evaluates the PR', async () => {
    const probot = await makeProbot();
    nockToken();
    nockBranchRules(IN_SCOPE_RULES);
    nockCommits(['PRJ-1: finished work']);
    nockJiraIssue('PRJ-1', 'Closed', 'done');
    nockCheckRunsRead(HEAD_SHA, []);
    let inProgress: any;
    const post = nockInProgressPost((b) => {
      inProgress = b;
    });
    let body: any;
    const patch = nockCheckRunPatch(777, (b) => {
      body = b;
    });

    await probot.receive({
      name: 'pull_request',
      id: 'evt-ed-1',
      payload: editedPayload({
        base: { ref: { from: 'develop' }, sha: { from: '5555555555' } },
      }),
    } as any);

    expect(post.isDone()).toBe(true);
    expect(inProgress.head_sha).toBe(HEAD_SHA);
    expect(inProgress.status).toBe('in_progress');
    expect(patch.isDone()).toBe(true);
    expect(body.conclusion).toBe('success');
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('title-only edit: zero GitHub/Jira calls', async () => {
    const probot = await makeProbot();

    // No interceptors defined; any API call would fail the receive.
    await probot.receive({
      name: 'pull_request',
      id: 'evt-ed-2',
      payload: editedPayload({ title: { from: 'Old title' } }),
    } as any);

    expect(nock.pendingMocks()).toEqual([]);
  });
});

describe('check_suite.rerequested', () => {
  it('non-empty pull_requests[]: evaluates the listed PR without resolving via the commit', async () => {
    const probot = await makeProbot();
    nockToken();
    // No GET /commits/{sha}/pulls interceptor: taking the fork-fallback path
    // would reject the receive under disableNetConnect.
    nockBranchRules(IN_SCOPE_RULES);
    nockCommits(['PRJ-1: finished work']);
    nockJiraIssue('PRJ-1', 'Closed', 'done');
    nockCheckRunsRead(HEAD_SHA, []);
    let inProgress: any;
    const post = nockInProgressPost((b) => {
      inProgress = b;
    });
    let body: any;
    const patch = nockCheckRunPatch(777, (b) => {
      body = b;
    });

    await probot.receive({
      name: 'check_suite',
      id: 'evt-cs-1',
      payload: {
        action: 'rerequested',
        check_suite: {
          id: 43001,
          head_sha: HEAD_SHA,
          pull_requests: [
            { number: 7, head: { sha: HEAD_SHA }, base: { ref: 'main', sha: BASE_SHA } },
          ],
        },
        repository: REPOSITORY,
        organization: { login: OWNER, id: 5001 },
        installation: { id: 2 },
        sender: { login: 'octocat', type: 'User' },
      },
    } as any);

    expect(post.isDone()).toBe(true);
    expect(inProgress.head_sha).toBe(HEAD_SHA);
    expect(inProgress.status).toBe('in_progress');
    expect(patch.isDone()).toBe(true);
    expect(body.conclusion).toBe('success');
    expect(nock.pendingMocks()).toEqual([]);
  });
});

describe('check_run.rerequested guard', () => {
  it('ignores a rerequest for a differently named check', async () => {
    const probot = await makeProbot();
    const payload = fixture('check_run.rerequested.json');
    payload.check_run.name = 'other-check';

    await probot.receive({ name: 'check_run', id: 'evt-cr-1', payload } as any);

    expect(nock.pendingMocks()).toEqual([]);
  });

  it('ignores a rerequest for a check owned by a different app', async () => {
    const probot = await makeProbot();
    const payload = fixture('check_run.rerequested.json');
    payload.check_run.app.id = 99999;

    await probot.receive({ name: 'check_run', id: 'evt-cr-2', payload } as any);

    expect(nock.pendingMocks()).toEqual([]);
  });
});

describe('installation.created coverage warning', () => {
  it('repository_selection "selected": warns about coverage mismatch and still configures', async () => {
    const records: LogRecord[] = [];
    const probot = await makeProbot(records);
    nockToken();
    const list = nock(GH).get('/orgs/acme/rulesets').query(true).reply(200, []);

    await probot.receive({
      name: 'installation',
      id: 'evt-in-1',
      payload: fixture('installation.created.json'), // repository_selection: "selected"
    } as any);

    expect(list.isDone()).toBe(true);
    const warns = records.filter(
      (r) => r.level === 'warn' && r.data['evt'] === 'installation_coverage_warning',
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]!.data['org']).toBe('acme');
    expect(warns[0]!.data['repository_selection']).toBe('selected');
  });

  it('repository_selection "all": no coverage warning', async () => {
    const records: LogRecord[] = [];
    const probot = await makeProbot(records);
    nockToken();
    const list = nock(GH).get('/orgs/acme/rulesets').query(true).reply(200, []);

    const payload = fixture('installation.created.json');
    payload.installation.repository_selection = 'all';
    await probot.receive({ name: 'installation', id: 'evt-in-2', payload } as any);

    expect(list.isDone()).toBe(true);
    expect(
      records.filter(
        (r) => r.level === 'warn' && r.data['evt'] === 'installation_coverage_warning',
      ),
    ).toHaveLength(0);
  });
});
