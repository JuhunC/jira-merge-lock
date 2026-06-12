import { describe, expect, it } from 'vitest';
import { buildCommentVerdict, countNonAuthorComments } from '../../src/comments.js';
import { ConfigError, loadConfig, testEnv } from '../../src/config.js';
import { makeApp } from '../../src/index.js';
import { evaluateAllChecks, evaluateCommentCheck } from '../../src/pipeline.js';
import { ScopeCache } from '../../src/rulesets.js';
import type { LoggerLike, OctokitLike, PullRef } from '../../src/types.js';

const APP_ID = 12345; // testEnv's APP_ID

function silentLog(): LoggerLike {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

interface RecordedCall {
  route: string;
  params: Record<string, unknown>;
}

/** Structural Octokit fake: route -> handler(params) -> data. */
function makeOctokit(handlers: Record<string, (params: any) => any>): {
  octokit: OctokitLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const lookup = (route: string, params: Record<string, unknown>): any => {
    const handler = handlers[route];
    if (!handler) throw new Error(`no fake handler for ${route}`);
    return handler(params);
  };
  const octokit: OctokitLike = {
    async request(route, params) {
      calls.push({ route, params: params ?? {} });
      return { data: lookup(route, params ?? {}), status: 200, headers: {} };
    },
    async paginate(route, params) {
      calls.push({ route, params: params ?? {} });
      const data = lookup(route, params ?? {});
      return Array.isArray(data) ? data : [];
    },
  };
  return { octokit, calls };
}

const PULL: PullRef = {
  owner: 'acme',
  repo: 'widgets',
  pullNumber: 7,
  headSha: 'aaa',
  baseRef: 'main',
  baseSha: 'bbb',
  authorLogin: 'author',
};

const ISSUE_COMMENTS = 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments';
const REVIEW_COMMENTS = 'GET /repos/{owner}/{repo}/pulls/{pull_number}/comments';
const REVIEWS = 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews';

function user(login: string, type = 'User'): { login: string; type: string } {
  return { login, type };
}

describe('countNonAuthorComments', () => {
  it('counts non-author humans across all three sources', async () => {
    const { octokit } = makeOctokit({
      [ISSUE_COMMENTS]: () => [{ user: user('alice') }, { user: user('author') }],
      [REVIEW_COMMENTS]: () => [{ user: user('bob') }],
      [REVIEWS]: () => [
        { user: user('carol'), body: 'looks good' },
        { user: user('dave'), body: '' }, // bare review without text: not a comment
        { user: user('dave'), body: '   ' },
      ],
    });
    const { count } = await countNonAuthorComments(octokit, PULL, 10);
    expect(count).toBe(3); // alice + bob + carol
  });

  it('excludes the author (case-insensitive), bots, and authorless items', async () => {
    const { octokit } = makeOctokit({
      [ISSUE_COMMENTS]: () => [
        { user: user('AUTHOR') }, // author, different case
        { user: user('ci-helper', 'Bot') },
        { user: null }, // deleted account
        {},
        { user: user('eve') },
      ],
      [REVIEW_COMMENTS]: () => [],
      [REVIEWS]: () => [],
    });
    const { count } = await countNonAuthorComments(octokit, PULL, 10);
    expect(count).toBe(1);
  });

  it('stops at the threshold and skips later endpoints entirely', async () => {
    const { octokit, calls } = makeOctokit({
      [ISSUE_COMMENTS]: () => [{ user: user('alice') }, { user: user('bob') }],
      [REVIEW_COMMENTS]: () => {
        throw new Error('must not be called once satisfied');
      },
      [REVIEWS]: () => {
        throw new Error('must not be called once satisfied');
      },
    });
    const { count } = await countNonAuthorComments(octokit, PULL, 2);
    expect(count).toBe(2);
    expect(calls.map((c) => c.route)).toEqual([ISSUE_COMMENTS]);
  });

  it('resolves the author via the PR endpoint when the ref does not carry it', async () => {
    const { octokit, calls } = makeOctokit({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': () => ({ user: user('author') }),
      [ISSUE_COMMENTS]: () => [{ user: user('author') }, { user: user('alice') }],
      [REVIEW_COMMENTS]: () => [],
      [REVIEWS]: () => [],
    });
    const { count, authorLogin } = await countNonAuthorComments(
      octokit,
      { ...PULL, authorLogin: undefined },
      10,
    );
    expect(authorLogin).toBe('author');
    expect(count).toBe(1);
    expect(calls[0]!.route).toBe('GET /repos/{owner}/{repo}/pulls/{pull_number}');
  });
});

describe('buildCommentVerdict', () => {
  const cfg = loadConfig(testEnv({ MIN_PR_COMMENTS: '2' }));

  it('succeeds at/above the threshold with a count-capped stable fingerprint', () => {
    const at = buildCommentVerdict(2, cfg);
    const above = buildCommentVerdict(9, cfg);
    expect(at.conclusion).toBe('success');
    expect(at.fingerprint).toBe('comments|success|2/2');
    expect(above.fingerprint).toBe(at.fingerprint); // more discussion ≠ rewrite
    expect(at.title).toContain('≥2');
  });

  it('fails below the threshold, fingerprint tracking the found count', () => {
    const none = buildCommentVerdict(0, cfg);
    const one = buildCommentVerdict(1, cfg);
    expect(none.conclusion).toBe('failure');
    expect(none.fingerprint).toBe('comments|failure|0/2');
    expect(one.fingerprint).toBe('comments|failure|1/2');
    expect(one.title).toBe(
      'Blocked: needs 2 comments from someone other than the author (found 1)',
    );
    expect(one.summary).toContain('other than the pull request author');
  });

  it('uses singular wording for a threshold of 1', () => {
    const single = loadConfig(testEnv({ MIN_PR_COMMENTS: '1' }));
    expect(buildCommentVerdict(0, single).title).toBe(
      'Blocked: needs 1 comment from someone other than the author (found 0)',
    );
  });
});

describe('config: MIN_PR_COMMENTS / COMMENT_CHECK_NAME', () => {
  it('defaults to disabled with the category default name', () => {
    const cfg = loadConfig(testEnv());
    expect(cfg.minPrComments).toBe(0);
    expect(cfg.commentCheckName).toBe('merge-lock/min-comment');
  });

  it('parses the threshold and honors an explicit name', () => {
    const cfg = loadConfig(
      testEnv({ MIN_PR_COMMENTS: '3', COMMENT_CHECK_NAME: 'peer-discussion' }),
    );
    expect(cfg.minPrComments).toBe(3);
    expect(cfg.commentCheckName).toBe('peer-discussion');
  });

  it('keeps the category default even under a custom CHECK_NAME', () => {
    expect(loadConfig(testEnv({ CHECK_NAME: 'my-lock' })).commentCheckName).toBe(
      'merge-lock/min-comment',
    );
  });

  it('rejects negatives and a name colliding with CHECK_NAME', () => {
    expect(() => loadConfig(testEnv({ MIN_PR_COMMENTS: '-1' }))).toThrow(ConfigError);
    expect(() =>
      loadConfig(testEnv({ COMMENT_CHECK_NAME: 'merge-lock/jira-issue' })),
    ).toThrow(ConfigError);
  });
});

// --- pipeline integration -------------------------------------------------

const IN_SCOPE_RULES = [
  {
    type: 'required_status_checks',
    parameters: {
      required_status_checks: [{ context: 'merge-lock/jira-issue', integration_id: APP_ID }],
    },
  },
];

const BRANCH_RULES = 'GET /repos/{owner}/{repo}/rules/branches/{branch}';
const CHECK_RUNS_READ = 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs';
const CHECK_RUNS_POST = 'POST /repos/{owner}/{repo}/check-runs';
const CHECK_RUNS_PATCH = 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}';

function pipelineDeps(octokit: OctokitLike, cfg = loadConfig(testEnv({ MIN_PR_COMMENTS: '1' }))) {
  return {
    octokit,
    jira: { getIssueStatuses: async () => [] } as any,
    cfg,
    scopeCache: new ScopeCache(60_000),
    log: silentLog(),
  };
}

describe('evaluateCommentCheck', () => {
  it('poll: posts a completed run named after the comment check', async () => {
    const posted: any[] = [];
    const { octokit } = makeOctokit({
      [BRANCH_RULES]: () => IN_SCOPE_RULES,
      [CHECK_RUNS_READ]: () => ({ check_runs: [] }),
      [ISSUE_COMMENTS]: () => [{ user: user('alice') }],
      [CHECK_RUNS_POST]: (p) => {
        posted.push(p);
        return { id: 1 };
      },
    });
    await evaluateCommentCheck(pipelineDeps(octokit), PULL, 'poll');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      name: 'merge-lock/min-comment',
      head_sha: 'aaa',
      status: 'completed',
      conclusion: 'success',
      external_id: 'comments|success|1/1',
    });
  });

  it('poll: fingerprint dedupe skips the write', async () => {
    const posted: any[] = [];
    const { octokit } = makeOctokit({
      [BRANCH_RULES]: () => IN_SCOPE_RULES,
      [CHECK_RUNS_READ]: () => ({
        check_runs: [{ external_id: 'comments|success|1/1', conclusion: 'success' }],
      }),
      [ISSUE_COMMENTS]: () => [{ user: user('alice') }],
      [CHECK_RUNS_POST]: (p) => {
        posted.push(p);
        return { id: 1 };
      },
    });
    await evaluateCommentCheck(pipelineDeps(octokit), PULL, 'poll');
    expect(posted).toHaveLength(0);
  });

  it('live: posts in_progress then completes it with the failure verdict', async () => {
    const posted: any[] = [];
    const patched: any[] = [];
    const { octokit } = makeOctokit({
      [BRANCH_RULES]: () => IN_SCOPE_RULES,
      [CHECK_RUNS_READ]: () => ({ check_runs: [] }),
      [ISSUE_COMMENTS]: () => [{ user: user('author') }],
      [REVIEW_COMMENTS]: () => [],
      [REVIEWS]: () => [],
      [CHECK_RUNS_POST]: (p) => {
        posted.push(p);
        return { id: 42 };
      },
      [CHECK_RUNS_PATCH]: (p) => {
        patched.push(p);
        return {};
      },
    });
    await evaluateCommentCheck(pipelineDeps(octokit), PULL, 'webhook');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ name: 'merge-lock/min-comment', status: 'in_progress' });
    expect(patched).toHaveLength(1);
    expect(patched[0]).toMatchObject({
      check_run_id: 42,
      conclusion: 'failure',
      external_id: 'comments|failure|0/1',
    });
  });

  it('feeds the status tracker: failure locks, success unlocks', async () => {
    const { StatusTracker } = await import('../../src/status.js');
    const tracker = new StatusTracker(() => 0);
    const comments: any[][] = [[{ user: user('author') }], [{ user: user('alice') }]];
    const { octokit } = makeOctokit({
      [BRANCH_RULES]: () => IN_SCOPE_RULES,
      [CHECK_RUNS_READ]: () => ({ check_runs: [] }),
      [ISSUE_COMMENTS]: () => comments.shift(),
      [REVIEW_COMMENTS]: () => [],
      [REVIEWS]: () => [],
      [CHECK_RUNS_POST]: () => ({ id: 1 }),
    });
    const deps = { ...pipelineDeps(octokit), status: tracker };

    await evaluateCommentCheck(deps, PULL, 'poll'); // 0 comments -> failure
    expect(tracker.snapshot().lockedPrs).toHaveLength(1);
    expect(tracker.snapshot().lockedPrs[0]).toMatchObject({
      check: 'merge-lock/min-comment',
      pullNumber: 7,
    });

    await evaluateCommentCheck(deps, PULL, 'poll'); // 1 comment -> success
    expect(tracker.snapshot().lockedPrs).toHaveLength(0);
    // Both were verdict changes, so both appear in the feed.
    expect(tracker.snapshot().recentEvaluations).toHaveLength(2);
  });

  it('out of scope: never counts comments, supersedes nothing when no prior run', async () => {
    const posted: any[] = [];
    const { octokit, calls } = makeOctokit({
      [BRANCH_RULES]: () => [],
      [CHECK_RUNS_READ]: () => ({ check_runs: [] }),
      [CHECK_RUNS_POST]: (p) => {
        posted.push(p);
        return { id: 1 };
      },
    });
    await evaluateCommentCheck(pipelineDeps(octokit), PULL, 'webhook');
    expect(posted).toHaveLength(0);
    expect(calls.map((c) => c.route)).not.toContain(ISSUE_COMMENTS);
  });
});

describe('evaluateAllChecks', () => {
  function fullHandlers(posted: any[]): Record<string, (params: any) => any> {
    return {
      [BRANCH_RULES]: () => IN_SCOPE_RULES,
      [CHECK_RUNS_READ]: () => ({ check_runs: [] }),
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits': () => [
        { sha: 'c1', commit: { message: 'no keys here' } },
      ],
      [ISSUE_COMMENTS]: () => [{ user: user('alice') }],
      [CHECK_RUNS_POST]: (p) => {
        posted.push(p);
        return { id: 1 };
      },
    };
  }

  it('runs both checks when the comment gate is enabled', async () => {
    const posted: any[] = [];
    const { octokit } = makeOctokit(fullHandlers(posted));
    await evaluateAllChecks(pipelineDeps(octokit), PULL, 'poll');
    expect(posted.map((p) => p.name)).toEqual(['merge-lock/jira-issue', 'merge-lock/min-comment']);
  });

  it('runs only the Jira check when MIN_PR_COMMENTS=0', async () => {
    const posted: any[] = [];
    const { octokit, calls } = makeOctokit(fullHandlers(posted));
    await evaluateAllChecks(pipelineDeps(octokit, loadConfig(testEnv())), PULL, 'poll');
    expect(posted.map((p) => p.name)).toEqual(['merge-lock/jira-issue']);
    expect(calls.map((c) => c.route)).not.toContain(ISSUE_COMMENTS);
  });
});

// --- webhook wiring ---------------------------------------------------------

function fakeApp(): { app: any; handlers: Map<string, (context: any) => Promise<void>> } {
  const handlers = new Map<string, (context: any) => Promise<void>>();
  const app = {
    on(events: string | string[], fn: (context: any) => Promise<void>) {
      for (const event of Array.isArray(events) ? events : [events]) handlers.set(event, fn);
    },
    onAny() {},
    log: silentLog(),
  };
  return { app, handlers };
}

describe('comment webhooks', () => {
  const cfgEnabled = loadConfig(testEnv({ MIN_PR_COMMENTS: '1' }));
  const PR_PAYLOAD = {
    number: 7,
    state: 'open',
    head: { sha: 'aaa' },
    base: { ref: 'main', sha: 'bbb' },
    user: { login: 'author' },
  };

  it('registers comment handlers only when the gate is enabled', () => {
    const off = fakeApp();
    makeApp(loadConfig(testEnv()), { jira: {} as any, scopeCache: new ScopeCache(1) })(off.app);
    expect(off.handlers.has('issue_comment.created')).toBe(false);

    const on = fakeApp();
    makeApp(cfgEnabled, { jira: {} as any, scopeCache: new ScopeCache(1) })(on.app);
    for (const event of [
      'issue_comment.created',
      'issue_comment.deleted',
      'pull_request_review.submitted',
      'pull_request_review_comment.created',
    ]) {
      expect(on.handlers.has(event)).toBe(true);
    }
  });

  it('issue_comment on an open PR fetches the PR and re-evaluates the comment check', async () => {
    const posted: any[] = [];
    const patched: any[] = [];
    const { octokit } = makeOctokit({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': () => PR_PAYLOAD,
      [BRANCH_RULES]: () => IN_SCOPE_RULES,
      [CHECK_RUNS_READ]: () => ({ check_runs: [] }),
      [ISSUE_COMMENTS]: () => [{ user: user('alice') }],
      [CHECK_RUNS_POST]: (p) => {
        posted.push(p);
        return { id: 9 };
      },
      [CHECK_RUNS_PATCH]: (p) => {
        patched.push(p);
        return {};
      },
    });
    const { app, handlers } = fakeApp();
    makeApp(cfgEnabled, { jira: {} as any, scopeCache: new ScopeCache(60_000) })(app);
    await handlers.get('issue_comment.created')!({
      octokit,
      log: silentLog(),
      payload: {
        repository: { name: 'widgets', owner: { login: 'acme' } },
        issue: { number: 7, state: 'open', pull_request: {} },
      },
    });
    // in_progress POST for the COMMENT check only, completed as success.
    expect(posted.map((p) => p.name)).toEqual(['merge-lock/min-comment']);
    expect(patched[0]).toMatchObject({ conclusion: 'success' });
  });

  it('ignores comments on plain issues and closed PRs', async () => {
    const { octokit, calls } = makeOctokit({});
    const { app, handlers } = fakeApp();
    makeApp(cfgEnabled, { jira: {} as any, scopeCache: new ScopeCache(1) })(app);
    const base = { repository: { name: 'widgets', owner: { login: 'acme' } } };

    await handlers.get('issue_comment.created')!({
      octokit,
      log: silentLog(),
      payload: { ...base, issue: { number: 7, state: 'open' } }, // no pull_request marker
    });
    await handlers.get('pull_request_review.submitted')!({
      octokit,
      log: silentLog(),
      payload: { ...base, pull_request: { ...PR_PAYLOAD, state: 'closed' } },
    });
    expect(calls).toHaveLength(0);
  });
});
