#!/usr/bin/env node
/**
 * Capacity benchmark: runs the REAL poller + evaluation pipeline (lib/) against
 * in-process fake GitHub/Jira backends with injectable per-request latency,
 * and measures full poll-cycle wall-clock time and API-call counts.
 *
 *   npm run build && node tools/bench-poll.mjs
 *
 * Two cycles run per scenario: cycle 1 is COLD (every PR needs a check-run
 * write), cycle 2 is STEADY STATE (fingerprint dedupe → near-zero writes) —
 * steady state is what repeats every POLL_INTERVAL_SECONDS in production.
 *
 * Latency model: every GitHub request/paginate call and every Jira lookup
 * batch awaits a fixed delay. Results scale linearly in latency, so numbers
 * for other networks can be derived: duration ≈ calls/concurrency × latency.
 */
import { loadConfig, testEnv } from '../lib/config.js';
import { createPoller } from '../lib/poller.js';
import { ScopeCache } from '../lib/rulesets.js';

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const silentLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return silentLog; } };

/** Build a synthetic org fleet + a structural Octokit honoring every route
 * the poller/pipeline touches. Check runs persist across cycles (dedupe). */
function makeFleet({ repos, prsPerRepo, keysPerPr, ghLatencyMs, minComments }) {
  const ORG = 'acme';
  const checkRunStore = new Map(); // `${sha}|${name}` -> external_id
  const counters = { github: 0, posts: 0 };

  const repoList = Array.from({ length: repos }, (_, i) => ({
    id: i + 1,
    name: `repo-${i}`,
    owner: { login: ORG },
  }));

  const prList = (repo) =>
    Array.from({ length: prsPerRepo }, (_, i) => ({
      number: i + 1,
      head: { sha: `${repo}-head-${i}` },
      base: { ref: 'main', sha: 'base' },
      user: { login: 'author' },
    }));

  // keysPerPr unique keys per PR + one key shared by EVERY PR (exercises the
  // per-cycle Jira dedupe cache exactly like a real epic/umbrella issue).
  const commitsFor = (repo, pr) => {
    const keys = Array.from({ length: keysPerPr }, (_, k) => `PRJ-${repo}${pr}${k}`.toUpperCase());
    const message = `${keys.map((k, i) => `K${i}: ${k}`).join('\n')}\nshared: SHARED-1`;
    return [{ sha: `c-${repo}-${pr}`, commit: { message } }];
  };

  const inScopeRules = [
    {
      type: 'required_status_checks',
      parameters: {
        required_status_checks: [
          { context: 'merge-lock/jira-issue', integration_id: 12345 },
          ...(minComments > 0
            ? [{ context: 'merge-lock/min-comment', integration_id: 12345 }]
            : []),
        ],
      },
    },
  ];

  const rulesetDetail = {
    id: 9,
    name: 'merge-lock-main',
    target: 'branch',
    enforcement: 'active',
    rules: inScopeRules,
  };

  async function handle(route, params) {
    counters.github += 1;
    await sleep(ghLatencyMs);
    switch (route) {
      case 'GET /app/installations':
        return [{ id: 101, account: { login: ORG, type: 'Organization' } }];
      case 'GET /orgs/{org}/rulesets':
        return [{ id: 9, name: 'merge-lock-main', target: 'branch' }];
      case 'GET /orgs/{org}/rulesets/{ruleset_id}':
        return rulesetDetail;
      case 'GET /installation/repositories':
        return repoList;
      case 'GET /repos/{owner}/{repo}/pulls':
        return prList(params.repo);
      case 'GET /repos/{owner}/{repo}/rules/branches/{branch}':
        return inScopeRules;
      case 'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits':
        return commitsFor(params.repo, params.pull_number);
      case 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs': {
        const id = checkRunStore.get(`${params.ref}|${params.check_name}`);
        return id
          ? { check_runs: [{ external_id: id, conclusion: 'x' }] }
          : { check_runs: [] };
      }
      case 'POST /repos/{owner}/{repo}/check-runs':
        counters.posts += 1;
        checkRunStore.set(`${params.head_sha}|${params.name}`, params.external_id ?? '');
        return { id: 1 };
      case 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments':
        return [{ user: { login: 'reviewer', type: 'User' } }];
      case 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments':
        return [];
      case 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews':
        return [];
      default:
        throw new Error(`bench: no handler for ${route}`);
    }
  }

  const octokit = {
    async request(route, params) {
      return { data: await handle(route, params ?? {}), status: 200, headers: {} };
    },
    async paginate(route, params) {
      const data = await handle(route, params ?? {});
      return Array.isArray(data) ? data : [data];
    },
  };

  return { octokit, counters };
}

/** Jira fake honoring the per-cycle cache contract; per call it sleeps once
 * per concurrency-5 wave of uncached keys (mirrors JiraClient's pool(5)). */
function makeJira({ jiraLatencyMs }) {
  const counters = { lookups: 0 };
  return {
    counters,
    jira: {
      async getIssueStatuses(keys, cache) {
        const distinct = [...new Set(keys)];
        const misses = distinct.filter((k) => !cache?.get(k));
        counters.lookups += misses.length;
        const waves = Math.ceil(misses.length / 5);
        for (let i = 0; i < waves; i++) await sleep(jiraLatencyMs);
        return distinct.map((key) => {
          const hit = cache?.get(key);
          if (hit) return hit;
          const outcome = { key, outcome: 'found', statusName: 'In Progress', statusCategoryKey: 'indeterminate' };
          cache?.set(key, outcome);
          return outcome;
        });
      },
    },
  };
}

async function runScenario(s) {
  const cfg = loadConfig(
    testEnv({
      POLL_CONCURRENCY: String(s.concurrency),
      MIN_PR_COMMENTS: s.minComments > 0 ? String(s.minComments) : undefined,
    }),
  );
  const { octokit, counters: gh } = makeFleet({ ...s, ghLatencyMs: s.ghLatencyMs });
  const { jira, counters: jr } = makeJira({ jiraLatencyMs: s.jiraLatencyMs });

  const poller = createPoller({
    auth: async () => octokit,
    cfg,
    jira,
    scopeCache: new ScopeCache(1), // expire instantly: every cycle re-checks scope (worst case)
    log: silentLog,
  });

  const cycles = [];
  for (let i = 0; i < 2; i++) {
    const before = { github: gh.github, posts: gh.posts, lookups: jr.lookups };
    const t0 = performance.now();
    await poller.runOnce();
    cycles.push({
      seconds: (performance.now() - t0) / 1000,
      github: gh.github - before.github,
      posts: gh.posts - before.posts,
      lookups: jr.lookups - before.lookups,
    });
  }
  return cycles;
}

const GH_LAT = Number(process.env.BENCH_GH_LATENCY_MS ?? 25);
const JIRA_LAT = Number(process.env.BENCH_JIRA_LATENCY_MS ?? 40);

const scenarios = [
  { name: '100 PRs / gate on', repos: 10, prsPerRepo: 10, keysPerPr: 2, concurrency: 5, minComments: 1 },
  { name: '500 PRs / gate on', repos: 25, prsPerRepo: 20, keysPerPr: 2, concurrency: 5, minComments: 1 },
  { name: '1000 PRs / gate on', repos: 50, prsPerRepo: 20, keysPerPr: 2, concurrency: 5, minComments: 1 },
  { name: '2000 PRs / gate on', repos: 100, prsPerRepo: 20, keysPerPr: 2, concurrency: 5, minComments: 1 },
  { name: '1000 PRs / gate OFF', repos: 50, prsPerRepo: 20, keysPerPr: 2, concurrency: 5, minComments: 0 },
  { name: '1000 PRs / conc 20', repos: 50, prsPerRepo: 20, keysPerPr: 2, concurrency: 20, minComments: 1 },
  { name: '1000 PRs / conc 50', repos: 50, prsPerRepo: 20, keysPerPr: 2, concurrency: 50, minComments: 1 },
];

const only = process.env.BENCH_ONLY;
const selected = only ? scenarios.filter((s) => s.name.includes(only)) : scenarios;

console.log(`latency model: GitHub ${GH_LAT} ms/call, Jira ${JIRA_LAT} ms/wave (5-way)\n`);
console.log(
  'scenario'.padEnd(22),
  'cycle'.padEnd(7),
  'wall-clock'.padEnd(11),
  'GH calls'.padEnd(9),
  'writes'.padEnd(7),
  'Jira lookups',
);
for (const s of selected) {
  const cycles = await runScenario({ ...s, ghLatencyMs: GH_LAT, jiraLatencyMs: JIRA_LAT });
  cycles.forEach((c, i) => {
    console.log(
      (i === 0 ? s.name : '').padEnd(22),
      (i === 0 ? 'cold' : 'steady').padEnd(7),
      `${c.seconds.toFixed(1)}s`.padEnd(11),
      String(c.github).padEnd(9),
      String(c.posts).padEnd(7),
      String(c.lookups),
    );
  });
}
