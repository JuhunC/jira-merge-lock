import { describe, expect, it } from 'vitest';
import { loadConfig, testEnv } from '../../src/config.js';
import {
  ScopeCache,
  autoconfigureOrg,
  discoverPrefixRulesets,
  isInScope,
  repoCouldMatch,
} from '../../src/rulesets.js';
import type { LoggerLike, OctokitLike, OrgRuleset } from '../../src/types.js';

const cfg = loadConfig(testEnv()); // appId 12345, checkName/prefix "jira-merge-lock"

interface RecordedCall {
  via: 'request' | 'paginate';
  route: string;
  params: Record<string, unknown> | undefined;
}

function fakeOctokit(handlers: {
  paginate?: (route: string, params?: Record<string, unknown>) => unknown[];
  request?: (route: string, params?: Record<string, unknown>) => unknown;
}): { octokit: OctokitLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const octokit: OctokitLike = {
    async request(route, params) {
      calls.push({ via: 'request', route, params });
      const data = handlers.request ? handlers.request(route, params) : {};
      return { data, status: 200, headers: {} };
    },
    async paginate(route, params) {
      calls.push({ via: 'paginate', route, params });
      return handlers.paginate ? handlers.paginate(route, params) : [];
    },
  };
  return { octokit, calls };
}

function fakeLog(): { log: LoggerLike; lines: Array<{ level: string; obj: unknown; msg?: string }> } {
  const lines: Array<{ level: string; obj: unknown; msg?: string }> = [];
  const mk = (level: string) => (obj: object | string, msg?: string) => {
    lines.push({ level, obj, msg });
  };
  return { log: { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') }, lines };
}

function logged(lines: Array<{ level: string; obj: unknown }>, level: string): Array<Record<string, unknown>> {
  return lines.filter((l) => l.level === level).map((l) => l.obj as Record<string, unknown>);
}

const branchRulesRoute = 'GET /repos/{owner}/{repo}/rules/branches/{branch}';

function rscBranchRule(entries: Array<{ context: string; integration_id?: number | null }>): unknown {
  return { type: 'required_status_checks', parameters: { required_status_checks: entries } };
}

describe('isInScope', () => {
  const ref = { owner: 'acme', repo: 'api', branch: 'release/1.x' };

  it('true when our check is required, and passes the branch RAW (octokit encodes placeholders)', async () => {
    const { octokit, calls } = fakeOctokit({
      paginate: () => [rscBranchRule([{ context: cfg.checkName, integration_id: cfg.appId }])],
    });
    await expect(isInScope(octokit, ref, cfg)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.via).toBe('paginate');
    expect(calls[0]!.route).toBe(branchRulesRoute);
    // The branch contains "/" and must arrive UN-encoded: octokit
    // URL-encodes path placeholder values itself; pre-encoding would
    // double-encode and 404 slashed branches as out-of-scope.
    expect(calls[0]!.params).toMatchObject({ owner: 'acme', repo: 'api', branch: 'release/1.x' });
  });

  it('enumerates ALL branch rules via paginate with per_page 100 — entry past item 100 still in scope', async () => {
    // The branch-rules endpoint is paginated (default page size 30). A single
    // non-paginated request would truncate the list and flip in-scope branches
    // to "skipped", bypassing the merge gate. Simulate >100 flattened rules
    // with our entry dead LAST.
    const filler = Array.from({ length: 120 }, (_, i) =>
      rscBranchRule([{ context: `ci/other-${i}`, integration_id: 999 }]),
    );
    const allRules = [...filler, rscBranchRule([{ context: cfg.checkName, integration_id: cfg.appId }])];
    const { octokit, calls } = fakeOctokit({ paginate: () => allRules });

    await expect(isInScope(octokit, ref, cfg)).resolves.toBe(true);

    // paginate — NOT request — must be used, with per_page 100.
    expect(calls.filter((c) => c.via === 'request')).toHaveLength(0);
    const paginates = calls.filter((c) => c.via === 'paginate');
    expect(paginates).toHaveLength(1);
    expect(paginates[0]!.route).toBe(branchRulesRoute);
    expect(paginates[0]!.params).toMatchObject({
      owner: 'acme',
      repo: 'api',
      branch: 'release/1.x',
      per_page: 100,
    });
  });

  it('true when the matching entry has no integration_id', async () => {
    const { octokit } = fakeOctokit({ paginate: () => [rscBranchRule([{ context: cfg.checkName }])] });
    await expect(isInScope(octokit, ref, cfg)).resolves.toBe(true);
  });

  it('false when only other contexts or other apps require checks', async () => {
    const { octokit } = fakeOctokit({
      paginate: () => [
        rscBranchRule([
          { context: 'ci/build', integration_id: cfg.appId },
          { context: cfg.checkName, integration_id: 99999 },
        ]),
        { type: 'pull_request', parameters: {} },
      ],
    });
    await expect(isInScope(octokit, ref, cfg)).resolves.toBe(false);
  });

  it('false when no rules apply', async () => {
    const { octokit } = fakeOctokit({ paginate: () => [] });
    await expect(isInScope(octokit, ref, cfg)).resolves.toBe(false);
  });

  it('404 from paginate -> false with a warn log', async () => {
    const { log, lines } = fakeLog();
    const { octokit } = fakeOctokit({
      paginate: () => {
        // octokit.paginate surfaces HTTP errors as a thrown RequestError-like
        // object carrying `status`, same shape as octokit.request.
        throw Object.assign(new Error('Not Found'), { status: 404 });
      },
    });
    await expect(isInScope(octokit, ref, cfg, undefined, log)).resolves.toBe(false);
    expect(logged(lines, 'warn')).toHaveLength(1);
  });

  it('non-404 errors propagate', async () => {
    const { octokit } = fakeOctokit({
      paginate: () => {
        throw Object.assign(new Error('boom'), { status: 500 });
      },
    });
    await expect(isInScope(octokit, ref, cfg)).rejects.toThrow('boom');
  });

  it('cache hit avoids a second call; invalidateOrg forces a refetch', async () => {
    const cache = new ScopeCache(60_000);
    const { octokit, calls } = fakeOctokit({
      paginate: () => [rscBranchRule([{ context: cfg.checkName, integration_id: cfg.appId }])],
    });
    await expect(isInScope(octokit, ref, cfg, cache)).resolves.toBe(true);
    await expect(isInScope(octokit, ref, cfg, cache)).resolves.toBe(true);
    expect(calls).toHaveLength(1);

    cache.invalidateOrg('acme');
    await expect(isInScope(octokit, ref, cfg, cache)).resolves.toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('negative results (incl. 404) are cached too', async () => {
    const cache = new ScopeCache(60_000);
    const { octokit, calls } = fakeOctokit({
      paginate: () => {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      },
    });
    await expect(isInScope(octokit, ref, cfg, cache)).resolves.toBe(false);
    await expect(isInScope(octokit, ref, cfg, cache)).resolves.toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('invalidateOrg only clears the named org', async () => {
    const cache = new ScopeCache(60_000);
    cache.set('acme', 'api', 'main', true);
    cache.set('umbrella', 'api', 'main', false);
    cache.invalidateOrg('acme');
    expect(cache.get('acme', 'api', 'main')).toBeUndefined();
    expect(cache.get('umbrella', 'api', 'main')).toBe(false);
  });
});

const listRoute = 'GET /orgs/{org}/rulesets';
const detailRoute = 'GET /orgs/{org}/rulesets/{ruleset_id}';
const putRoute = 'PUT /orgs/{org}/rulesets/{ruleset_id}';

function richRuleset(overrides: Partial<OrgRuleset> = {}): OrgRuleset {
  return {
    id: 42,
    node_id: 'RRS_abc',
    name: 'jira-merge-lock-main',
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [{ actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }],
    conditions: {
      ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
      repository_name: { include: ['~ALL'], exclude: [] },
    },
    rules: [
      { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: 'ci/build', integration_id: 999 }],
        },
      },
    ],
    _links: { self: { href: 'https://api.github.com/orgs/acme/rulesets/42' } },
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-06-01T00:00:00Z',
    source: 'acme',
    source_type: 'Organization',
    current_user_can_bypass: 'never',
    ...overrides,
  };
}

describe('discoverPrefixRulesets', () => {
  it('filters by prefix and branch target, refetches detail per id, never trusts list rules', async () => {
    const detail = richRuleset();
    const { log, lines } = fakeLog();
    const { octokit, calls } = fakeOctokit({
      paginate: () => [
        // List item carries a BOGUS rules field — it must be ignored.
        { id: 42, name: 'jira-merge-lock-main', target: 'branch', rules: [{ type: 'bogus' }] },
        { id: 2, name: 'unrelated', target: 'branch' },
        { id: 3, name: 'jira-merge-lock-tags', target: 'tag' },
        { id: 4, name: 'jira-merge-lock-norules', target: 'branch' },
        { id: 5, name: 'jira-merge-lock-untargeted' }, // target undefined => kept
      ],
      request: (_route, params) => {
        if (params?.['ruleset_id'] === 42) return structuredClone(detail);
        if (params?.['ruleset_id'] === 5)
          return richRuleset({ id: 5, name: 'jira-merge-lock-untargeted', rules: [] });
        return richRuleset({ id: 4, name: 'jira-merge-lock-norules', rules: undefined });
      },
    });

    const result = await discoverPrefixRulesets(octokit, 'acme', cfg, log);

    expect(calls[0]!.route).toBe(listRoute);
    expect(calls[0]!.params).toMatchObject({ org: 'acme', per_page: 100 });
    const detailCalls = calls.filter((c) => c.route === detailRoute);
    expect(detailCalls.map((c) => c.params?.['ruleset_id'])).toEqual([42, 4, 5]);

    expect(result.map((r) => r.id)).toEqual([42, 5]);
    expect(result[0]!.rules).toEqual(detail.rules); // detail, not the bogus list rules
    const errors = logged(lines, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ evt: 'ruleset_missing_rules', ruleset_id: 4 });
  });
});

describe('autoconfigureOrg', () => {
  it('rulesetAutoconfigure=false -> no API calls at all', async () => {
    const offCfg = loadConfig(testEnv({ RULESET_AUTOCONFIGURE: 'false' }));
    const { log } = fakeLog();
    const { octokit, calls } = fakeOctokit({});
    await autoconfigureOrg(octokit, 'acme', offCfg, log);
    expect(calls).toHaveLength(0);
  });

  it('converged org -> re-fetches before deciding but issues zero PUTs', async () => {
    const converged = richRuleset();
    converged.rules![1]!.parameters!.required_status_checks!.push({
      context: cfg.checkName,
      integration_id: cfg.appId,
    });
    const { log, lines } = fakeLog();
    const { octokit, calls } = fakeOctokit({
      paginate: () => [{ id: 42, name: converged.name, target: 'branch' }],
      request: () => structuredClone(converged),
    });

    await autoconfigureOrg(octokit, 'acme', cfg, log);

    // one detail GET from discovery + one pre-decision re-fetch
    expect(calls.filter((c) => c.route === detailRoute)).toHaveLength(2);
    expect(calls.filter((c) => c.route === putRoute)).toHaveLength(0);
    expect(logged(lines, 'error')).toHaveLength(0);
    expect(logged(lines, 'info')).toHaveLength(0);
  });

  it('missing entry -> exactly one PUT with untouched fields, merged rules, no read-only fields', async () => {
    const detail = richRuleset();
    const { log, lines } = fakeLog();
    const { octokit, calls } = fakeOctokit({
      paginate: () => [{ id: 42, name: detail.name, target: 'branch' }],
      request: (route, params) => {
        if (route === putRoute) return { ...structuredClone(detail), rules: structuredClone(params?.['rules']) };
        return structuredClone(detail);
      },
    });

    await autoconfigureOrg(octokit, 'acme', cfg, log);

    const puts = calls.filter((c) => c.route === putRoute);
    expect(puts).toHaveLength(1);
    const body = puts[0]!.params!;

    expect(body['org']).toBe('acme');
    expect(body['ruleset_id']).toBe(42);
    expect(body['name']).toBe('jira-merge-lock-main');
    expect(body['target']).toBe('branch');
    expect(body['enforcement']).toBe('active');
    expect(body['conditions']).toEqual(detail.conditions);
    expect(body['bypass_actors']).toEqual(detail['bypass_actors']);

    for (const gone of [
      'id',
      'node_id',
      '_links',
      'created_at',
      'updated_at',
      'source',
      'source_type',
      'current_user_can_bypass',
    ]) {
      expect(body).not.toHaveProperty(gone);
    }

    const rules = body['rules'] as OrgRuleset['rules'];
    expect(JSON.stringify(rules![0])).toBe(JSON.stringify(detail.rules![0]));
    const rsc = rules![1]!;
    expect(rsc.parameters!.strict_required_status_checks_policy).toBe(true);
    expect(rsc.parameters!.required_status_checks).toEqual([
      { context: 'ci/build', integration_id: 999 },
      { context: cfg.checkName, integration_id: cfg.appId },
    ]);

    expect(logged(lines, 'error')).toHaveLength(0);
    const infos = logged(lines, 'info');
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ evt: 'ruleset_autoconfig', org: 'acme', ruleset: detail.name, action: 'injected' });
  });

  it('rules-undefined on the pre-decision re-fetch -> error log, no PUT', async () => {
    const detail = richRuleset();
    let detailGets = 0;
    const { log, lines } = fakeLog();
    const { octokit, calls } = fakeOctokit({
      paginate: () => [{ id: 42, name: detail.name, target: 'branch' }],
      request: (route) => {
        if (route === detailRoute) {
          detailGets += 1;
          if (detailGets === 1) return structuredClone(detail); // discovery sees rules…
          return richRuleset({ rules: undefined }); // …re-fetch does not
        }
        return {};
      },
    });

    await autoconfigureOrg(octokit, 'acme', cfg, log);

    expect(calls.filter((c) => c.route === putRoute)).toHaveLength(0);
    const errors = logged(lines, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ evt: 'ruleset_missing_rules', ruleset_id: 42 });
  });

  it('PUT response missing a rule we sent -> error log with before/after', async () => {
    const detail = richRuleset();
    const { log, lines } = fakeLog();
    const { octokit } = fakeOctokit({
      paginate: () => [{ id: 42, name: detail.name, target: 'branch' }],
      request: (route) => {
        if (route === putRoute) return { ...structuredClone(detail), rules: [] }; // clobbered
        return structuredClone(detail);
      },
    });

    await autoconfigureOrg(octokit, 'acme', cfg, log);

    const errors = logged(lines, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ evt: 'ruleset_autoconfig_verify_failed', ruleset_id: 42 });
    expect((errors[0]!['missing'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('wrong integration_id -> one PUT, action repinned', async () => {
    const detail = richRuleset();
    detail.rules![1]!.parameters!.required_status_checks!.push({ context: cfg.checkName, integration_id: 777 });
    const { log, lines } = fakeLog();
    const { octokit, calls } = fakeOctokit({
      paginate: () => [{ id: 42, name: detail.name, target: 'branch' }],
      request: (route, params) => {
        if (route === putRoute) return { ...structuredClone(detail), rules: structuredClone(params?.['rules']) };
        return structuredClone(detail);
      },
    });

    await autoconfigureOrg(octokit, 'acme', cfg, log);

    expect(calls.filter((c) => c.route === putRoute)).toHaveLength(1);
    expect(logged(lines, 'info')[0]).toMatchObject({ evt: 'ruleset_autoconfig', action: 'repinned' });
  });
});

describe('repoCouldMatch', () => {
  const repo = { id: 7, name: 'api-server' };
  const rs = (conditions?: OrgRuleset['conditions']): OrgRuleset => ({
    id: 1,
    name: 'jira-merge-lock-x',
    ...(conditions !== undefined ? { conditions } : {}),
  });

  it('no prefix rulesets -> false (nothing can be in scope)', () => {
    expect(repoCouldMatch([], repo)).toBe(false);
  });

  it('no conditions / no repo condition -> true', () => {
    expect(repoCouldMatch([rs()], repo)).toBe(true);
    expect(repoCouldMatch([rs({ ref_name: { include: ['~ALL'] } })], repo)).toBe(true);
  });

  it('repository_id: matches by ids list', () => {
    expect(repoCouldMatch([rs({ repository_id: { repository_ids: [7, 8] } })], repo)).toBe(true);
    expect(repoCouldMatch([rs({ repository_id: { repository_ids: [8, 9] } })], repo)).toBe(false);
  });

  it('repository_name globs: ~ALL, *, ?, and regex-char escaping', () => {
    const byName = (include: string[], exclude: string[] = []) =>
      repoCouldMatch([rs({ repository_name: { include, exclude } })], repo);

    expect(byName(['~ALL'])).toBe(true);
    expect(byName(['api-*'])).toBe(true);
    expect(byName(['web-*'])).toBe(false);
    expect(byName(['api-server?'])).toBe(false); // ? = exactly one char
    expect(byName(['api-serve?'])).toBe(true);
    expect(byName(['api.server'])).toBe(false); // "." is literal, not regex-any
    expect(repoCouldMatch([rs({ repository_name: { include: ['a.b'] } })], { id: 1, name: 'a.b' })).toBe(true);
    expect(byName(['~ALL'], ['api-*'])).toBe(false); // exclude wins
    expect(byName(['~ALL'], ['legacy-*'])).toBe(true);
  });

  it('unevaluable conditions are conservative: repository_property or protected -> true', () => {
    expect(repoCouldMatch([rs({ repository_property: { include: [], exclude: [] } })], repo)).toBe(true);
    expect(
      repoCouldMatch([rs({ repository_name: { include: ['web-*'], exclude: [], protected: true } })], repo),
    ).toBe(true);
  });

  it('true unless EVERY ruleset definitively cannot match', () => {
    const cannot = rs({ repository_id: { repository_ids: [99] } });
    const can = rs({ repository_name: { include: ['api-*'], exclude: [] } });
    expect(repoCouldMatch([cannot, can], repo)).toBe(true);
    expect(repoCouldMatch([cannot, cannot], repo)).toBe(false);
  });
});
