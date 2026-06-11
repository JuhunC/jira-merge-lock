/**
 * Pipeline-level policy tests: evaluatePullRequest is driven directly with
 * structural fakes (OctokitLike + a stub JiraClient) — no Probot, no HTTP.
 *
 * Pins the degraded-mode and scope policies:
 *  - Jira outage + latest run `skipped`  -> fail closed (skipped is a scope
 *    marker, not a verdict; GitHub treats skipped as passing a required check)
 *  - Jira outage + latest run is a real verdict -> keep it, zero writes
 *  - JiraAuthError (config failure)      -> zero writes, error log only
 *  - out-of-scope + existing real run    -> superseded by a skipped run
 *  - out-of-scope + no run / already skipped -> zero writes
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, testEnv } from '../../src/config.js';
import type { JiraClient } from '../../src/jira.js';
import { evaluatePullRequest, type PipelineDeps } from '../../src/pipeline.js';
import { ScopeCache } from '../../src/rulesets.js';
import { JiraAuthError, JiraUnavailableError } from '../../src/types.js';
import type { JiraIssueOutcome, LoggerLike, OctokitLike, PullRef } from '../../src/types.js';

const cfg = loadConfig(testEnv({ POLL_INTERVAL_SECONDS: '0' }));

const HEAD_SHA = '1111111111111111111111111111111111111111';
const BASE_SHA = '2222222222222222222222222222222222222222';

const PULL: PullRef = {
  owner: 'acme',
  repo: 'widgets',
  pullNumber: 7,
  headSha: HEAD_SHA,
  baseRef: 'main',
  baseSha: BASE_SHA,
};

const IN_SCOPE_RULES = [
  {
    type: 'required_status_checks',
    ruleset_id: 2,
    parameters: {
      strict_required_status_checks_policy: false,
      required_status_checks: [{ context: cfg.checkName, integration_id: cfg.appId }],
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

interface FakeGithub {
  branchRules: unknown[];
  commits?: string[];
  /** check_runs returned by the latest-run read (already filtered/latest). */
  latestRuns?: Array<{ id?: number; external_id?: string | null; conclusion?: string | null }>;
}

function makeFakeOctokit(state: FakeGithub): {
  octokit: OctokitLike;
  posted: Array<Record<string, unknown>>;
  checkRunReads: () => number;
} {
  const posted: Array<Record<string, unknown>> = [];
  let reads = 0;
  const octokit: OctokitLike = {
    async request(route, parameters = {}) {
      if (route === 'POST /repos/{owner}/{repo}/check-runs') {
        posted.push(parameters);
        return { data: { id: 1 }, status: 201, headers: {} };
      }
      if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs') {
        reads += 1;
        const runs = state.latestRuns ?? [];
        return {
          data: { total_count: runs.length, check_runs: runs },
          status: 200,
          headers: {},
        };
      }
      throw new Error(`fake octokit: unexpected request ${route}`);
    },
    async paginate(route) {
      if (route === 'GET /repos/{owner}/{repo}/rules/branches/{branch}') {
        return state.branchRules;
      }
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits') {
        return (state.commits ?? []).map((message, i) => ({
          sha: `commitsha${i}`,
          commit: { message },
        }));
      }
      throw new Error(`fake octokit: unexpected paginate ${route}`);
    },
  };
  return { octokit, posted, checkRunReads: () => reads };
}

/** Structural JiraClient stub: resolves outcomes or throws the given error.
 * (JiraClient has private fields, so the cast is required — only
 * getIssueStatuses is reachable from the pipeline.) */
function makeJiraStub(
  behavior: { outcomes?: JiraIssueOutcome[]; error?: Error } = {},
): { jira: JiraClient; calls: () => number } {
  let calls = 0;
  const stub = {
    async getIssueStatuses(): Promise<JiraIssueOutcome[]> {
      calls += 1;
      if (behavior.error) throw behavior.error;
      return behavior.outcomes ?? [];
    },
  };
  return { jira: stub as unknown as JiraClient, calls: () => calls };
}

interface LogEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  obj: Record<string, unknown>;
  msg?: string;
}

function makeLogSpy(): { log: LoggerLike; events: LogEvent[] } {
  const events: LogEvent[] = [];
  const push =
    (level: LogEvent['level']) =>
    (obj: object | string, msg?: string): void => {
      events.push({
        level,
        obj: typeof obj === 'string' ? { message: obj } : (obj as Record<string, unknown>),
        msg,
      });
    };
  return {
    log: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') },
    events,
  };
}

function makeDeps(
  github: FakeGithub,
  jiraBehavior: { outcomes?: JiraIssueOutcome[]; error?: Error } = {},
) {
  const { octokit, posted, checkRunReads } = makeFakeOctokit(github);
  const { jira, calls: jiraCalls } = makeJiraStub(jiraBehavior);
  const { log, events } = makeLogSpy();
  const deps: PipelineDeps = {
    octokit,
    jira,
    cfg,
    scopeCache: new ScopeCache(60_000),
    log,
  };
  return { deps, posted, checkRunReads, jiraCalls, events };
}

describe('pipeline policy: Jira outage (JiraUnavailableError)', () => {
  it('latest run is `skipped`: fails closed — posts the jira_unreachable failure run', async () => {
    const { deps, posted, checkRunReads } = makeDeps(
      {
        branchRules: IN_SCOPE_RULES,
        commits: ['PRJ-1: solo change'],
        latestRuns: [{ id: 9, external_id: `skipped|${cfg.configHash}`, conclusion: 'skipped' }],
      },
      { error: new JiraUnavailableError('down', 'unreachable') },
    );

    await evaluatePullRequest(deps, PULL, 'webhook');

    expect(posted).toHaveLength(1);
    const body = posted[0]!;
    expect(body['name']).toBe(cfg.checkName);
    expect(body['head_sha']).toBe(HEAD_SHA);
    expect(body['status']).toBe('completed');
    expect(body['conclusion']).toBe('failure');
    expect((body['output'] as { title: string }).title).toBe(
      'Jira unreachable — cannot verify referenced issues',
    );
    // The degraded path already read the latest run; the write step reuses it.
    expect(checkRunReads()).toBe(1);
  });

  it.each(['failure', 'success'] as const)(
    'latest run is a real verdict (%s): keeps it — zero writes, kept_last_verdict logged',
    async (conclusion) => {
      const { deps, posted, events } = makeDeps(
        {
          branchRules: IN_SCOPE_RULES,
          commits: ['PRJ-1: solo change'],
          latestRuns: [{ id: 9, external_id: 'previous-fingerprint', conclusion }],
        },
        { error: new JiraUnavailableError('down', 'timeout') },
      );

      await evaluatePullRequest(deps, PULL, 'webhook');

      expect(posted).toHaveLength(0);
      const kept = events.find((e) => e.obj['evt'] === 'jira_degraded');
      expect(kept).toBeDefined();
      expect(kept!.level).toBe('info');
      expect(kept!.obj['action']).toBe('kept_last_verdict');
      expect(kept!.obj['kind']).toBe('timeout');
    },
  );

  it('no run at all on the SHA: fails closed — posts the jira_unreachable failure run', async () => {
    const { deps, posted } = makeDeps(
      {
        branchRules: IN_SCOPE_RULES,
        commits: ['PRJ-1: solo change'],
        latestRuns: [],
      },
      { error: new JiraUnavailableError('down') },
    );

    await evaluatePullRequest(deps, PULL, 'webhook');

    expect(posted).toHaveLength(1);
    expect(posted[0]!['conclusion']).toBe('failure');
  });
});

describe('pipeline policy: Jira credential failure (JiraAuthError)', () => {
  it('never writes a check run — logs jira_auth_failed at error and returns', async () => {
    const { deps, posted, checkRunReads, events } = makeDeps(
      {
        branchRules: IN_SCOPE_RULES,
        commits: ['PRJ-1: solo change'],
        // A run exists; a regression into the outage branch would "keep" it
        // silently — a regression into the verdict path would POST. Both are
        // distinguishable from the correct zero-read, zero-write behavior.
        latestRuns: [{ id: 9, external_id: 'previous-fingerprint', conclusion: 'failure' }],
      },
      { error: new JiraAuthError('Jira rejected credentials (401)') },
    );

    await evaluatePullRequest(deps, PULL, 'webhook');

    expect(posted).toHaveLength(0);
    expect(checkRunReads()).toBe(0);
    const authEvt = events.find((e) => e.obj['evt'] === 'jira_auth_failed');
    expect(authEvt).toBeDefined();
    expect(authEvt!.level).toBe('error');
    // Config failure must not be misfiled as an outage.
    expect(events.some((e) => e.obj['evt'] === 'jira_degraded')).toBe(false);
  });
});

describe('pipeline policy: out-of-scope base branch', () => {
  it('existing non-skipped run: supersedes it with a skipped run', async () => {
    const { deps, posted, jiraCalls } = makeDeps({
      branchRules: OUT_OF_SCOPE_RULES,
      latestRuns: [{ id: 9, external_id: 'fp-old', conclusion: 'failure' }],
    });

    await evaluatePullRequest(deps, PULL, 'webhook');

    expect(posted).toHaveLength(1);
    const body = posted[0]!;
    expect(body['name']).toBe(cfg.checkName);
    expect(body['head_sha']).toBe(HEAD_SHA);
    expect(body['conclusion']).toBe('skipped');
    expect(body['external_id']).toBe(`skipped|${cfg.configHash}`);
    const output = body['output'] as { title: string; summary: string };
    expect(output.title).toBe('Not in scope');
    expect(output.summary).toContain(PULL.baseRef);
    expect(output.summary).toContain(cfg.rulesetNamePrefix);
    // Out-of-scope evaluation must never touch Jira.
    expect(jiraCalls()).toBe(0);
  });

  it('no existing run: zero writes', async () => {
    const { deps, posted, jiraCalls } = makeDeps({
      branchRules: OUT_OF_SCOPE_RULES,
      latestRuns: [],
    });

    await evaluatePullRequest(deps, PULL, 'webhook');

    expect(posted).toHaveLength(0);
    expect(jiraCalls()).toBe(0);
  });

  it('latest run already skipped: zero writes (no noise)', async () => {
    const { deps, posted } = makeDeps({
      branchRules: OUT_OF_SCOPE_RULES,
      latestRuns: [{ id: 9, external_id: `skipped|${cfg.configHash}`, conclusion: 'skipped' }],
    });

    await evaluatePullRequest(deps, PULL, 'webhook');

    expect(posted).toHaveLength(0);
  });
});
