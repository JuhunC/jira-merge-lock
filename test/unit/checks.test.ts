import { describe, expect, it } from 'vitest';
import { findLatestCheckRun, postCheckRun, postSkippedRun } from '../../src/checks.js';
import { loadConfig, testEnv } from '../../src/config.js';
import type { OctokitLike, Verdict } from '../../src/types.js';

const LIST_ROUTE = 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs';
const CREATE_ROUTE = 'POST /repos/{owner}/{repo}/check-runs';

const cfg = loadConfig(testEnv());

const ref = {
  owner: 'acme',
  repo: 'widgets',
  headSha: 'head000',
  checkName: cfg.checkName,
  appId: cfg.appId,
};

interface RecordedCall {
  route: string;
  params?: Record<string, unknown>;
}

function makeOctokit(responses: Record<string, unknown>): {
  octokit: OctokitLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const octokit: OctokitLike = {
    async request(route, params) {
      calls.push({ route, params });
      const data = responses[route];
      if (data === undefined) throw new Error(`unexpected request: ${route}`);
      return { data, status: route.startsWith('POST') ? 201 : 200, headers: {} };
    },
    async paginate(route) {
      throw new Error(`unexpected paginate: ${route}`);
    },
  };
  return { octokit, calls };
}

const verdict: Verdict = {
  conclusion: 'failure',
  issues: [{ key: 'PRJ-1', statusName: 'In Progress', blocking: true, note: 'In Progress' }],
  title: 'Blocked: 1 of 1 Jira issues not done',
  summary: '| PRJ-1 | In Progress | Yes |',
  fingerprint: 'abc123fingerprint',
};

describe('findLatestCheckRun', () => {
  it('queries with check_name, app_id and filter=latest on the head SHA', async () => {
    const { octokit, calls } = makeOctokit({
      [LIST_ROUTE]: { check_runs: [{ external_id: 'fp-1', conclusion: 'failure' }] },
    });

    const result = await findLatestCheckRun(octokit, ref);

    expect(result).toEqual({ externalId: 'fp-1', conclusion: 'failure' });
    expect(calls).toEqual([
      {
        route: LIST_ROUTE,
        params: {
          owner: 'acme',
          repo: 'widgets',
          ref: 'head000',
          check_name: cfg.checkName,
          app_id: cfg.appId,
          filter: 'latest',
          per_page: 1,
        },
      },
    ]);
  });

  it('returns null when no run exists', async () => {
    const { octokit } = makeOctokit({ [LIST_ROUTE]: { check_runs: [] } });
    expect(await findLatestCheckRun(octokit, ref)).toBeNull();
  });

  it('maps a missing external_id to null', async () => {
    const { octokit } = makeOctokit({
      [LIST_ROUTE]: { check_runs: [{ conclusion: 'success' }] },
    });
    expect(await findLatestCheckRun(octokit, ref)).toEqual({
      externalId: null,
      conclusion: 'success',
    });
  });
});

describe('postCheckRun', () => {
  it('creates a completed run with the exact body and never PATCHes', async () => {
    const { octokit, calls } = makeOctokit({ [CREATE_ROUTE]: { id: 1 } });

    await postCheckRun(octokit, ref, verdict);

    expect(calls).toEqual([
      {
        route: CREATE_ROUTE,
        params: {
          owner: 'acme',
          repo: 'widgets',
          name: cfg.checkName,
          head_sha: 'head000',
          status: 'completed',
          conclusion: 'failure',
          external_id: 'abc123fingerprint',
          output: {
            title: 'Blocked: 1 of 1 Jira issues not done',
            summary: '| PRJ-1 | In Progress | Yes |',
          },
        },
      },
    ]);
  });
});

describe('postSkippedRun', () => {
  it('is a noop when we never posted a run on this SHA', async () => {
    const { octokit, calls } = makeOctokit({ [LIST_ROUTE]: { check_runs: [] } });

    const result = await postSkippedRun(octokit, ref, 'not covered', cfg.configHash);

    expect(result).toBe('noop');
    expect(calls.map((c) => c.route)).toEqual([LIST_ROUTE]);
  });

  it('is a noop when the latest run is already skipped', async () => {
    const { octokit, calls } = makeOctokit({
      [LIST_ROUTE]: { check_runs: [{ external_id: `skipped|${cfg.configHash}`, conclusion: 'skipped' }] },
    });

    const result = await postSkippedRun(octokit, ref, 'not covered', cfg.configHash);

    expect(result).toBe('noop');
    expect(calls.map((c) => c.route)).toEqual([LIST_ROUTE]);
  });

  it('supersedes a non-skipped run with a skipped run', async () => {
    const { octokit, calls } = makeOctokit({
      [LIST_ROUTE]: { check_runs: [{ external_id: 'fp-old', conclusion: 'failure' }] },
      [CREATE_ROUTE]: { id: 2 },
    });

    const result = await postSkippedRun(
      octokit,
      ref,
      'not covered by any jira-merge-lock* ruleset',
      cfg.configHash,
    );

    expect(result).toBe('posted');
    expect(calls[1]).toEqual({
      route: CREATE_ROUTE,
      params: {
        owner: 'acme',
        repo: 'widgets',
        name: cfg.checkName,
        head_sha: 'head000',
        status: 'completed',
        conclusion: 'skipped',
        external_id: `skipped|${cfg.configHash}`,
        output: {
          title: 'Not in scope',
          summary: 'not covered by any jira-merge-lock* ruleset',
        },
      },
    });
  });
});
