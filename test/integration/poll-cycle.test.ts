import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, testEnv, type AppConfig } from '../../src/config.js';
import type { JiraClient } from '../../src/jira.js';
import { createPoller } from '../../src/poller.js';
import { ScopeCache } from '../../src/rulesets.js';
import type {
  JiraCycleCache,
  JiraIssueOutcome,
  LoggerLike,
  OctokitLike,
} from '../../src/types.js';

const cfg: AppConfig = loadConfig(testEnv());

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  obj: Record<string, unknown>;
}

function makeLog(): { log: LoggerLike; entries: LogEntry[]; byEvt(evt: string): LogEntry[] } {
  const entries: LogEntry[] = [];
  const push =
    (level: LogEntry['level']) =>
    (obj: object | string, _msg?: string): void => {
      entries.push({ level, obj: typeof obj === 'string' ? { msg: obj } : (obj as Record<string, unknown>) });
    };
  return {
    log: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') },
    entries,
    byEvt: (evt) => entries.filter((e) => e.obj.evt === evt),
  };
}

type RouteHandler = (params: Record<string, any>) => unknown;

interface FakeOctokit extends OctokitLike {
  calls: Array<{ route: string; params: Record<string, any> }>;
}

function makeOctokit(routes: Record<string, RouteHandler>): FakeOctokit {
  const calls: FakeOctokit['calls'] = [];
  const dispatch = async (route: string, params: Record<string, any>): Promise<unknown> => {
    calls.push({ route, params });
    const handler = routes[route];
    if (!handler) throw new Error(`no fake handler for ${route}`);
    return handler(params);
  };
  return {
    calls,
    async request(route, parameters) {
      const data = await dispatch(route, (parameters ?? {}) as Record<string, any>);
      return { data, status: 200, headers: {} };
    },
    async paginate(route, parameters) {
      const data = await dispatch(route, (parameters ?? {}) as Record<string, any>);
      if (!Array.isArray(data)) throw new Error(`fake for ${route} must return an array`);
      return data;
    },
  };
}

function makeAuth(appOctokit: OctokitLike, byInstallation: Record<number, OctokitLike>) {
  const authed: Array<number | undefined> = [];
  return {
    authed,
    auth: async (installationId?: number): Promise<any> => {
      authed.push(installationId);
      if (installationId === undefined) return appOctokit;
      const octokit = byInstallation[installationId];
      if (!octokit) throw new Error(`no fake octokit for installation ${installationId}`);
      return octokit;
    },
  };
}

/** Mirrors JiraClient's per-cycle memoization: cache hits never count as
 * fetches, so `misses()` is the number of real Jira consultations. */
function makeJira(statuses: Record<string, JiraIssueOutcome>) {
  const calls: Array<{ keys: string[]; cache: JiraCycleCache | undefined }> = [];
  let misses = 0;
  const client = {
    async getIssueStatuses(keys: string[], cache?: JiraCycleCache): Promise<JiraIssueOutcome[]> {
      calls.push({ keys: [...keys], cache });
      const distinct = [...new Set(keys)];
      return distinct.map((key) => {
        const hit = cache?.get(key);
        if (hit) return hit;
        misses += 1;
        const outcome: JiraIssueOutcome = statuses[key] ?? { key, outcome: 'not_found' };
        cache?.set(key, outcome);
        return outcome;
      });
    },
  };
  return { jira: client as unknown as JiraClient, calls, misses: () => misses };
}

function fingerprint(conclusion: 'success' | 'failure', pairs: string[]): string {
  return createHash('sha256')
    .update(`${conclusion}|${[...pairs].sort().join(',')}|${cfg.configHash}`)
    .digest('hex');
}

function convergedRuleset(id: number, conditions?: Record<string, unknown>) {
  return {
    id,
    name: `${cfg.rulesetNamePrefix}-main`,
    target: 'branch',
    enforcement: 'active',
    conditions: conditions ?? { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          do_not_enforce_on_create: false,
          required_status_checks: [{ context: cfg.checkName, integration_id: cfg.appId }],
        },
      },
    ],
  };
}

const inScopeBranchRules = [
  {
    type: 'required_status_checks',
    parameters: { required_status_checks: [{ context: cfg.checkName, integration_id: cfg.appId }] },
  },
];

function pr(number: number, headSha: string, baseRef = 'main') {
  return { number, head: { sha: headSha }, base: { ref: baseRef, sha: 'base0000' } };
}

describe('poll cycle', () => {
  it('evaluates open PRs with fingerprint dedupe and one Jira consultation per key per cycle', async () => {
    // Both PRs reference PRJ-1 (In Progress => blocking => failure verdict).
    const expectedFp = fingerprint('failure', ['PRJ-1=In Progress']);
    const posted: Array<Record<string, any>> = [];

    const appOctokit = makeOctokit({
      'GET /app/installations': () => [{ id: 101, account: { login: 'acme', type: 'Organization' } }],
    });
    const orgOctokit = makeOctokit({
      'GET /orgs/{org}/rulesets': () => [
        { id: 9, name: `${cfg.rulesetNamePrefix}-main`, target: 'branch' },
      ],
      'GET /orgs/{org}/rulesets/{ruleset_id}': () => convergedRuleset(9),
      // Envelope shape: structural fakes don't flatten like octokit.paginate does.
      'GET /installation/repositories': () => [
        { total_count: 1, repositories: [{ id: 1, name: 'widgets', owner: { login: 'acme' } }] },
      ],
      'GET /repos/{owner}/{repo}/pulls': () => [pr(7, 'aaa'), pr(8, 'ccc')],
      'GET /repos/{owner}/{repo}/rules/branches/{branch}': () => inScopeBranchRules,
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits': () => [
        { commit: { message: 'PRJ-1: fix the thing' } },
      ],
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': (p) => ({
        check_runs: [
          p.ref === 'aaa'
            ? { external_id: 'stale-fingerprint-from-before', conclusion: 'failure' }
            : { external_id: expectedFp, conclusion: 'failure' },
        ],
      }),
      'POST /repos/{owner}/{repo}/check-runs': (p) => {
        posted.push(p);
        return {};
      },
    });

    const { auth } = makeAuth(appOctokit, { 101: orgOctokit });
    const { jira, calls, misses } = makeJira({
      'PRJ-1': { key: 'PRJ-1', outcome: 'found', statusName: 'In Progress', statusCategoryKey: 'indeterminate' },
    });
    const { log, entries, byEvt } = makeLog();

    const poller = createPoller({ auth, cfg, jira, scopeCache: new ScopeCache(60_000), log });
    await poller.runOnce();

    expect(entries.filter((e) => e.level === 'error')).toEqual([]);

    // PR1's existing run has a different external_id => exactly one POST.
    // PR2's existing run already carries the fresh fingerprint => no POST.
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      name: cfg.checkName,
      head_sha: 'aaa',
      conclusion: 'failure',
      external_id: expectedFp,
    });

    // The Jira layer was called once per PR but consulted once: the second
    // call hit the shared per-cycle cache.
    expect(calls).toHaveLength(2);
    expect(misses()).toBe(1);
    expect(calls[0]!.cache).toBeDefined();
    expect(calls[0]!.cache).toBe(calls[1]!.cache);

    const done = byEvt('poll_done');
    expect(done).toHaveLength(1);
    expect(done[0]!.obj).toMatchObject({
      installations: 1,
      repos_scanned: 1,
      repos_pruned: 0,
      prs: 2,
      // One distinct key fetched this cycle => jiraCycleCache size 1.
      jira_fetches: 1,
    });
    expect(typeof done[0]!.obj['duration_ms']).toBe('number');
  });

  it('skips non-Organization installations entirely, warning once per installation id', async () => {
    const appOctokit = makeOctokit({
      'GET /app/installations': () => [
        { id: 201, account: { login: 'jdoe', type: 'User' } },
        { id: 202, account: { login: 'acme', type: 'Organization' } },
      ],
    });
    const orgOctokit = makeOctokit({
      'GET /orgs/{org}/rulesets': () => [],
      'GET /installation/repositories': () => [{ id: 5, name: 'tools', owner: { login: 'acme' } }],
    });
    const { auth, authed } = makeAuth(appOctokit, { 202: orgOctokit });
    const { jira } = makeJira({});
    const { log, byEvt } = makeLog();

    const poller = createPoller({ auth, cfg, jira, scopeCache: new ScopeCache(60_000), log });
    await poller.runOnce();
    await poller.runOnce();

    expect(authed).not.toContain(201);
    expect(authed).toContain(202);

    const warns = byEvt('poll_skip_non_org_installation');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.level).toBe('warn');
    expect(warns[0]!.obj).toMatchObject({ installation_id: 201, account: 'jdoe' });

    // With zero prefix rulesets every repo is pruned (nothing can be in scope).
    const done = byEvt('poll_done');
    expect(done).toHaveLength(2);
    expect(done[0]!.obj).toMatchObject({ installations: 1, repos_scanned: 0, repos_pruned: 1, prs: 0 });
  });

  it("survives one installation's repo listing throwing and still processes the next", async () => {
    const posted: Array<Record<string, any>> = [];
    const appOctokit = makeOctokit({
      'GET /app/installations': () => [
        { id: 301, account: { login: 'broken', type: 'Organization' } },
        { id: 302, account: { login: 'works', type: 'Organization' } },
      ],
    });
    const brokenOctokit = makeOctokit({
      'GET /orgs/{org}/rulesets': () => [],
      'GET /installation/repositories': () => {
        throw new Error('listing exploded');
      },
    });
    const worksOctokit = makeOctokit({
      'GET /orgs/{org}/rulesets': () => [
        { id: 9, name: `${cfg.rulesetNamePrefix}-main`, target: 'branch' },
      ],
      'GET /orgs/{org}/rulesets/{ruleset_id}': () => convergedRuleset(9),
      // Flat shape (the normal octokit.paginate output).
      'GET /installation/repositories': () => [{ id: 1, name: 'api', owner: { login: 'works' } }],
      'GET /repos/{owner}/{repo}/pulls': () => [pr(1, 'eee')],
      'GET /repos/{owner}/{repo}/rules/branches/{branch}': () => inScopeBranchRules,
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits': () => [
        { commit: { message: 'PRJ-2: finish the work' } },
      ],
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': () => ({ check_runs: [] }),
      'POST /repos/{owner}/{repo}/check-runs': (p) => {
        posted.push(p);
        return {};
      },
    });

    const { auth } = makeAuth(appOctokit, { 301: brokenOctokit, 302: worksOctokit });
    const { jira } = makeJira({
      'PRJ-2': { key: 'PRJ-2', outcome: 'found', statusName: 'Closed', statusCategoryKey: 'done' },
    });
    const { log, byEvt } = makeLog();

    const poller = createPoller({ auth, cfg, jira, scopeCache: new ScopeCache(60_000), log });
    await poller.runOnce();

    const failures = byEvt('poll_installation_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.obj).toMatchObject({ installation_id: 301, org: 'broken' });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ head_sha: 'eee', conclusion: 'success' });

    expect(byEvt('poll_done')[0]!.obj).toMatchObject({
      installations: 2,
      repos_scanned: 1,
      repos_pruned: 0,
      prs: 1,
    });
  });

  it('prunes repos that cannot match any prefix ruleset before listing their PRs', async () => {
    const pullsListedFor: string[] = [];
    const appOctokit = makeOctokit({
      'GET /app/installations': () => [{ id: 401, account: { login: 'acme', type: 'Organization' } }],
    });
    const orgOctokit = makeOctokit({
      'GET /orgs/{org}/rulesets': () => [
        { id: 9, name: `${cfg.rulesetNamePrefix}-main`, target: 'branch' },
      ],
      'GET /orgs/{org}/rulesets/{ruleset_id}': () =>
        convergedRuleset(9, {
          ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
          repository_name: { include: ['widgets'], exclude: [] },
        }),
      'GET /installation/repositories': () => [
        { id: 1, name: 'widgets', owner: { login: 'acme' } },
        { id: 2, name: 'docs', owner: { login: 'acme' } },
      ],
      'GET /repos/{owner}/{repo}/pulls': (p) => {
        pullsListedFor.push(p['repo'] as string);
        return [];
      },
    });

    const { auth } = makeAuth(appOctokit, { 401: orgOctokit });
    const { jira } = makeJira({});
    const { log, byEvt } = makeLog();

    const poller = createPoller({ auth, cfg, jira, scopeCache: new ScopeCache(60_000), log });
    await poller.runOnce();

    expect(pullsListedFor).toEqual(['widgets']);
    expect(byEvt('poll_done')[0]!.obj).toMatchObject({
      installations: 1,
      repos_scanned: 1,
      repos_pruned: 1,
      prs: 0,
    });
  });

  it("survives one repo's PR listing throwing and still scans the installation's other repos", async () => {
    const posted: Array<Record<string, any>> = [];
    const appOctokit = makeOctokit({
      'GET /app/installations': () => [{ id: 501, account: { login: 'acme', type: 'Organization' } }],
    });
    const orgOctokit = makeOctokit({
      'GET /orgs/{org}/rulesets': () => [
        { id: 9, name: `${cfg.rulesetNamePrefix}-main`, target: 'branch' },
      ],
      'GET /orgs/{org}/rulesets/{ruleset_id}': () => convergedRuleset(9),
      'GET /installation/repositories': () => [
        { id: 1, name: 'broken', owner: { login: 'acme' } },
        { id: 2, name: 'healthy', owner: { login: 'acme' } },
      ],
      'GET /repos/{owner}/{repo}/pulls': (p) => {
        if (p['repo'] === 'broken') throw new Error('listing exploded (451)');
        return [pr(1, 'fff')];
      },
      'GET /repos/{owner}/{repo}/rules/branches/{branch}': () => inScopeBranchRules,
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits': () => [
        { commit: { message: 'PRJ-3: ship it' } },
      ],
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': () => ({ check_runs: [] }),
      'POST /repos/{owner}/{repo}/check-runs': (p) => {
        posted.push(p);
        return {};
      },
    });

    const { auth } = makeAuth(appOctokit, { 501: orgOctokit });
    const { jira } = makeJira({
      'PRJ-3': { key: 'PRJ-3', outcome: 'found', statusName: 'Closed', statusCategoryKey: 'done' },
    });
    const { log, byEvt } = makeLog();

    const poller = createPoller({ auth, cfg, jira, scopeCache: new ScopeCache(60_000), log });
    await poller.runOnce();

    const repoFailures = byEvt('poll_repo_failed');
    expect(repoFailures).toHaveLength(1);
    expect(repoFailures[0]!.level).toBe('error');
    expect(repoFailures[0]!.obj).toMatchObject({
      installation_id: 501,
      owner: 'acme',
      repo: 'broken',
    });

    // The healthy repo was still scanned and its PR evaluated.
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ head_sha: 'fff', conclusion: 'success' });

    // Repo-level isolation: the installation as a whole did NOT fail.
    expect(byEvt('poll_installation_failed')).toEqual([]);
    expect(byEvt('poll_done')[0]!.obj).toMatchObject({
      installations: 1,
      repos_scanned: 1,
      prs: 1,
      jira_fetches: 1,
    });
  });

  it("survives one PR's evaluation throwing and still evaluates the remaining PRs", async () => {
    const posted: Array<Record<string, any>> = [];
    const appOctokit = makeOctokit({
      'GET /app/installations': () => [{ id: 551, account: { login: 'acme', type: 'Organization' } }],
    });
    const orgOctokit = makeOctokit({
      'GET /orgs/{org}/rulesets': () => [
        { id: 9, name: `${cfg.rulesetNamePrefix}-main`, target: 'branch' },
      ],
      'GET /orgs/{org}/rulesets/{ruleset_id}': () => convergedRuleset(9),
      'GET /installation/repositories': () => [{ id: 1, name: 'widgets', owner: { login: 'acme' } }],
      'GET /repos/{owner}/{repo}/pulls': () => [pr(1, 'bad'), pr(2, 'good')],
      'GET /repos/{owner}/{repo}/rules/branches/{branch}': () => inScopeBranchRules,
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits': () => [
        { commit: { message: 'PRJ-4: finish the work' } },
      ],
      // A non-Jira error inside the pipeline (rethrown) for PR 1 only.
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': (p) => {
        if (p['ref'] === 'bad') throw new Error('github 500 on check-runs read');
        return { check_runs: [] };
      },
      'POST /repos/{owner}/{repo}/check-runs': (p) => {
        posted.push(p);
        return {};
      },
    });

    const { auth } = makeAuth(appOctokit, { 551: orgOctokit });
    const { jira } = makeJira({
      'PRJ-4': { key: 'PRJ-4', outcome: 'found', statusName: 'Closed', statusCategoryKey: 'done' },
    });
    const { log, byEvt } = makeLog();

    const poller = createPoller({ auth, cfg, jira, scopeCache: new ScopeCache(60_000), log });
    await poller.runOnce();

    const prFailures = byEvt('poll_pr_failed');
    expect(prFailures).toHaveLength(1);
    expect(prFailures[0]!.level).toBe('error');
    expect(prFailures[0]!.obj).toMatchObject({
      owner: 'acme',
      repo: 'widgets',
      pull_number: 1,
      head_sha: 'bad',
    });

    // PR 2 was still evaluated and got its check posted.
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ head_sha: 'good', conclusion: 'success' });

    // PR-level isolation: neither the repo nor the installation aborted.
    expect(byEvt('poll_repo_failed')).toEqual([]);
    expect(byEvt('poll_installation_failed')).toEqual([]);
    expect(byEvt('poll_done')[0]!.obj).toMatchObject({ installations: 1, repos_scanned: 1, prs: 2 });
  });

  it('pollInstallation(id) one-off: re-fetches the installation, autoconfigures, and evaluates its repos', async () => {
    const posted: Array<Record<string, any>> = [];
    const appOctokit = makeOctokit({
      'GET /app/installations/{installation_id}': (p) => ({
        id: p['installation_id'],
        account: { login: 'acme', type: 'Organization' },
        repository_selection: 'all',
      }),
    });
    const orgOctokit = makeOctokit({
      'GET /orgs/{org}/rulesets': () => [
        { id: 9, name: `${cfg.rulesetNamePrefix}-main`, target: 'branch' },
      ],
      'GET /orgs/{org}/rulesets/{ruleset_id}': () => convergedRuleset(9),
      'GET /installation/repositories': () => [{ id: 1, name: 'widgets', owner: { login: 'acme' } }],
      'GET /repos/{owner}/{repo}/pulls': () => [pr(3, 'abc')],
      'GET /repos/{owner}/{repo}/rules/branches/{branch}': () => inScopeBranchRules,
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits': () => [
        { commit: { message: 'PRJ-5: one-off poll' } },
      ],
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': () => ({ check_runs: [] }),
      'POST /repos/{owner}/{repo}/check-runs': (p) => {
        posted.push(p);
        return {};
      },
    });

    const { auth, authed } = makeAuth(appOctokit, { 601: orgOctokit });
    const { jira } = makeJira({
      'PRJ-5': { key: 'PRJ-5', outcome: 'found', statusName: 'Closed', statusCategoryKey: 'done' },
    });
    const { log, entries, byEvt } = makeLog();

    const poller = createPoller({ auth, cfg, jira, scopeCache: new ScopeCache(60_000), log });
    poller.pollInstallation(601);
    // The fakes are microtask-only, so one macrotask tick drains the whole run.
    await new Promise((resolve) => setImmediate(resolve));

    expect(entries.filter((e) => e.level === 'error')).toEqual([]);
    expect(appOctokit.calls).toEqual([
      { route: 'GET /app/installations/{installation_id}', params: { installation_id: 601 } },
    ]);
    expect(authed).toContain(601);

    // Auto-configure ran for the org (rulesets listed via the org client).
    expect(orgOctokit.calls.some((c) => c.route === 'GET /orgs/{org}/rulesets')).toBe(true);

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ head_sha: 'abc', conclusion: 'success' });

    const done = byEvt('poll_installation_done');
    expect(done).toHaveLength(1);
    expect(done[0]!.obj).toMatchObject({ installation_id: 601, repos_scanned: 1, prs: 1 });

    // repository_selection 'all' => no coverage warning.
    expect(byEvt('installation_coverage_warning')).toEqual([]);
  });

  it("warns once per installation per process when auto-configure runs with repository_selection 'selected'", async () => {
    const appOctokit = makeOctokit({
      'GET /app/installations': () => [
        {
          id: 651,
          account: { login: 'acme', type: 'Organization' },
          repository_selection: 'selected',
        },
      ],
    });
    const orgOctokit = makeOctokit({
      'GET /orgs/{org}/rulesets': () => [],
      'GET /installation/repositories': () => [],
    });
    const { auth } = makeAuth(appOctokit, { 651: orgOctokit });
    const { jira } = makeJira({});
    const { log, byEvt } = makeLog();

    const poller = createPoller({ auth, cfg, jira, scopeCache: new ScopeCache(60_000), log });
    await poller.runOnce();
    await poller.runOnce();

    const warns = byEvt('installation_coverage_warning');
    expect(warns).toHaveLength(1); // once per installation id per process, not per cycle
    expect(warns[0]!.level).toBe('warn');
    expect(warns[0]!.obj).toMatchObject({
      installation_id: 651,
      org: 'acme',
      repository_selection: 'selected',
    });
  });

  it("one-off pollInstallation warns when the re-fetched installation has repository_selection 'selected'", async () => {
    const appOctokit = makeOctokit({
      'GET /app/installations/{installation_id}': () => ({
        id: 652,
        account: { login: 'umbrella', type: 'Organization' },
        repository_selection: 'selected',
      }),
    });
    const orgOctokit = makeOctokit({
      'GET /orgs/{org}/rulesets': () => [],
      'GET /installation/repositories': () => [],
    });
    const { auth } = makeAuth(appOctokit, { 652: orgOctokit });
    const { jira } = makeJira({});
    const { log, byEvt } = makeLog();

    const poller = createPoller({ auth, cfg, jira, scopeCache: new ScopeCache(60_000), log });
    poller.pollInstallation(652);
    await new Promise((resolve) => setImmediate(resolve));

    const warns = byEvt('installation_coverage_warning');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj).toMatchObject({
      installation_id: 652,
      org: 'umbrella',
      repository_selection: 'selected',
    });
    expect(byEvt('poll_installation_done')).toHaveLength(1);
  });

  it('start() with pollIntervalSeconds=0 runs exactly one immediate cycle and schedules nothing', async () => {
    const cfg0: AppConfig = loadConfig(testEnv({ POLL_INTERVAL_SECONDS: '0' }));
    const appOctokit = makeOctokit({
      'GET /app/installations': () => [{ id: 701, account: { login: 'acme', type: 'Organization' } }],
    });
    const orgOctokit = makeOctokit({
      'GET /orgs/{org}/rulesets': () => [],
      'GET /installation/repositories': () => [],
    });
    const { auth } = makeAuth(appOctokit, { 701: orgOctokit });
    const { jira } = makeJira({});
    const { log, byEvt } = makeLog();

    const poller = createPoller({ auth, cfg: cfg0, jira, scopeCache: new ScopeCache(60_000), log });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      poller.start();
      // setImmediate is NOT faked: one real macrotask tick drains the
      // microtask-only fake call chain of the immediate cycle.
      await new Promise((resolve) => setImmediate(resolve));

      // The immediate cycle ran (startup auto-configure depends on this) ...
      expect(byEvt('poll_done')).toHaveLength(1);
      expect(orgOctokit.calls.some((c) => c.route === 'GET /orgs/{org}/rulesets')).toBe(true);
      // ... and no recurring tick was scheduled.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('start() with a positive interval runs the immediate cycle AND schedules a recurring tick', async () => {
    const appOctokit = makeOctokit({ 'GET /app/installations': () => [] });
    const { auth } = makeAuth(appOctokit, {});
    const { jira } = makeJira({});
    const { log, byEvt } = makeLog();

    const poller = createPoller({ auth, cfg, jira, scopeCache: new ScopeCache(60_000), log });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      poller.start();
      await new Promise((resolve) => setImmediate(resolve));

      expect(byEvt('poll_done')).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(1);
      poller.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a cycle while the previous one is still running (mutex)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const appOctokit = makeOctokit({
      'GET /app/installations': async () => {
        await gate;
        return [];
      },
    });
    const { auth } = makeAuth(appOctokit, {});
    const { jira } = makeJira({});
    const { log, byEvt } = makeLog();

    const poller = createPoller({ auth, cfg, jira, scopeCache: new ScopeCache(60_000), log });
    const first = poller.runOnce();
    const second = poller.runOnce();
    release();
    await Promise.all([first, second]);

    expect(byEvt('poll_skipped')).toHaveLength(1);
    expect(byEvt('poll_done')).toHaveLength(1);
  });
});
