import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import nock from 'nock';
import { Probot, ProbotOctokit } from 'probot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, testEnv } from '../../src/config.js';
import { makeApp } from '../../src/index.js';
import type { AppDeps } from '../../src/index.js';
import type { AppConfig } from '../../src/config.js';

const GH = 'https://api.github.com';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
}

async function makeProbot(cfg: AppConfig, deps?: AppDeps): Promise<Probot> {
  const probot = new Probot({
    appId: 12345,
    privateKey: PRIVATE_KEY,
    logLevel: 'fatal',
    Octokit: ProbotOctokit.defaults({
      retry: { enabled: false },
      throttle: { enabled: false },
    }),
  });
  await probot.load(makeApp(cfg, deps));
  return probot;
}

function nockToken(): nock.Scope {
  return nock(GH)
    .post('/app/installations/2/access_tokens')
    .reply(201, { token: 'test', permissions: {} });
}

const READ_ONLY_FIELDS = {
  node_id: 'RRS_x',
  created_at: '2026-05-01T10:00:00Z',
  updated_at: '2026-06-10T09:30:00Z',
  source: 'acme',
  source_type: 'Organization',
  current_user_can_bypass: 'never',
  _links: { self: { href: `${GH}/orgs/acme/rulesets/x` } },
};

const OUR_RULE = {
  type: 'required_status_checks',
  parameters: {
    strict_required_status_checks_policy: false,
    do_not_enforce_on_create: false,
    required_status_checks: [{ context: 'jira-merge-lock', integration_id: 12345 }],
  },
};

const convergedDetail = {
  id: 1,
  name: 'jira-merge-lock-main',
  target: 'branch',
  enforcement: 'active',
  conditions: {
    ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
    repository_name: { include: ['~ALL'], exclude: [] },
  },
  rules: [OUR_RULE],
  bypass_actors: [],
  ...READ_ONLY_FIELDS,
};

const driftedDetail = {
  id: 2,
  name: 'jira-merge-lock-release',
  target: 'branch',
  enforcement: 'active',
  conditions: {
    ref_name: { include: ['refs/heads/release/*'], exclude: ['refs/heads/release/legacy'] },
    repository_name: { include: ['widgets', 'gadgets-*'], exclude: [] },
  },
  rules: [
    { type: 'deletion' },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: [{ context: 'ci/build', integration_id: 999 }],
      },
    },
  ],
  bypass_actors: [{ actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }],
  ...READ_ONLY_FIELDS,
};

const listItems = [
  { id: 1, name: 'jira-merge-lock-main', target: 'branch', enforcement: 'active' },
  { id: 2, name: 'jira-merge-lock-release', target: 'branch', enforcement: 'active' },
  { id: 3, name: 'other-policy', target: 'branch', enforcement: 'active' },
];

beforeEach(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

describe('repository_ruleset webhook -> auto-configure', () => {
  it('injects our entry into the drifted ruleset with exactly one PUT', async () => {
    const cfg = loadConfig(testEnv({ POLL_INTERVAL_SECONDS: '0' }));
    const requestInstallationPoll = vi.fn();
    const probot = await makeProbot(cfg, { requestInstallationPoll });

    nockToken();
    nock(GH).get('/orgs/acme/rulesets').query(true).reply(200, listItems);
    // Each prefix-matched ruleset is fetched twice: once by discovery, once by
    // the re-fetch immediately before the merge decision.
    nock(GH).get('/orgs/acme/rulesets/1').times(2).reply(200, convergedDetail);
    nock(GH).get('/orgs/acme/rulesets/2').times(2).reply(200, driftedDetail);
    let putBody: any;
    const put = nock(GH)
      .put('/orgs/acme/rulesets/2', (body) => {
        putBody = body;
        return true;
      })
      .reply(200, () => ({ id: 2, name: 'jira-merge-lock-release', rules: putBody.rules }));

    await probot.receive({
      name: 'repository_ruleset',
      id: 'evt-rs-1',
      payload: fixture('repository_ruleset.edited.json'),
    } as any);

    expect(put.isDone()).toBe(true);
    // All defined interceptors consumed: list once, each detail twice, ONE PUT
    // (and no PUT for the converged ruleset — none was defined, and
    // disableNetConnect would have failed the receive on any extra call).
    expect(nock.pendingMocks()).toEqual([]);

    // Merged rules: foreign rule untouched, our entry appended, strict flag kept.
    expect(putBody.rules).toHaveLength(2);
    expect(putBody.rules[0]).toEqual({ type: 'deletion' });
    expect(putBody.rules[1]).toEqual({
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: [
          { context: 'ci/build', integration_id: 999 },
          { context: 'jira-merge-lock', integration_id: 12345 },
        ],
      },
    });

    // Conditions and bypass actors pass through byte-for-byte.
    expect(putBody.conditions).toEqual(driftedDetail.conditions);
    expect(putBody.bypass_actors).toEqual(driftedDetail.bypass_actors);
    expect(putBody.enforcement).toBe('active');

    // Read-only / server-managed fields never appear in the PUT body.
    for (const field of [
      'id',
      'node_id',
      '_links',
      'created_at',
      'updated_at',
      'source',
      'source_type',
      'current_user_can_bypass',
    ]) {
      expect(putBody).not.toHaveProperty(field);
    }

    expect(requestInstallationPoll).toHaveBeenCalledTimes(1);
    expect(requestInstallationPoll).toHaveBeenCalledWith(2);
  });

  it('RULESET_AUTOCONFIGURE=false: no ruleset API calls at all', async () => {
    const cfg = loadConfig(
      testEnv({ POLL_INTERVAL_SECONDS: '0', RULESET_AUTOCONFIGURE: 'false' }),
    );
    const requestInstallationPoll = vi.fn();
    const probot = await makeProbot(cfg, { requestInstallationPoll });

    // No interceptors at all: with disableNetConnect active, ANY GitHub call
    // (even the installation token request) would reject the receive below.
    await probot.receive({
      name: 'repository_ruleset',
      id: 'evt-rs-2',
      payload: fixture('repository_ruleset.edited.json'),
    } as any);

    expect(nock.pendingMocks()).toEqual([]);
    expect(requestInstallationPoll).toHaveBeenCalledWith(2);
  });
});

describe('installation.created -> auto-configure', () => {
  it('runs discovery for the new organization', async () => {
    const cfg = loadConfig(testEnv({ POLL_INTERVAL_SECONDS: '0' }));
    const probot = await makeProbot(cfg);

    nockToken();
    const list = nock(GH).get('/orgs/acme/rulesets').query(true).reply(200, []);

    await probot.receive({
      name: 'installation',
      id: 'evt-inst-1',
      payload: fixture('installation.created.json'),
    } as any);

    expect(list.isDone()).toBe(true);
  });
});
