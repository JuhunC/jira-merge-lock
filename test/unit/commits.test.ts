import { describe, expect, it } from 'vitest';
import { listPrCommitMessages } from '../../src/commits.js';
import type { OctokitLike, PullRef } from '../../src/types.js';

const COMMITS_ROUTE = 'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits';
const PULL_ROUTE = 'GET /repos/{owner}/{repo}/pulls/{pull_number}';
const COMPARE_ROUTE = 'GET /repos/{owner}/{repo}/compare/{basehead}';

const pull: PullRef = {
  owner: 'acme',
  repo: 'widgets',
  pullNumber: 7,
  headSha: 'head000',
  baseRef: 'main',
  baseSha: 'base000',
};

interface RecordedCall {
  route: string;
  params?: Record<string, unknown>;
}

function commitItem(message: string): { sha: string; commit: { message: string } } {
  return { sha: 'x', commit: { message } };
}

function commitItems(count: number, prefix: string): Array<{ sha: string; commit: { message: string } }> {
  return Array.from({ length: count }, (_, i) => commitItem(`${prefix}-${i}`));
}

function makeOctokit(opts: {
  paginateItems: Record<string, unknown[]>;
  requestData?: Record<string, unknown>;
}): { octokit: OctokitLike; paginateCalls: RecordedCall[]; requestCalls: RecordedCall[] } {
  const paginateCalls: RecordedCall[] = [];
  const requestCalls: RecordedCall[] = [];
  const octokit: OctokitLike = {
    async request(route, params) {
      requestCalls.push({ route, params });
      const data = opts.requestData?.[route];
      if (data === undefined) throw new Error(`unexpected request: ${route}`);
      return { data, status: 200, headers: {} };
    },
    async paginate(route, params) {
      paginateCalls.push({ route, params });
      const items = opts.paginateItems[route];
      if (items === undefined) throw new Error(`unexpected paginate: ${route}`);
      return items;
    },
  };
  return { octokit, paginateCalls, requestCalls };
}

describe('listPrCommitMessages', () => {
  it('returns a complete listing when under the 250 cap', async () => {
    const { octokit, paginateCalls, requestCalls } = makeOctokit({
      paginateItems: { [COMMITS_ROUTE]: [commitItem('PRJ-1: a'), commitItem('b'), commitItem('PRJ-2: c')] },
    });

    const result = await listPrCommitMessages(octokit, pull);

    expect(result).toEqual({
      messages: ['PRJ-1: a', 'b', 'PRJ-2: c'],
      entries: [
        { sha: 'x', message: 'PRJ-1: a' },
        { sha: 'x', message: 'b' },
        { sha: 'x', message: 'PRJ-2: c' },
      ],
      complete: true,
      totalCommits: 3,
    });
    expect(paginateCalls).toEqual([
      {
        route: COMMITS_ROUTE,
        params: { owner: 'acme', repo: 'widgets', pull_number: 7, per_page: 100 },
      },
    ]);
    expect(requestCalls).toEqual([]);
  });

  it('at exactly 250 items, trusts pulls.get when the true count is within the cap', async () => {
    const { octokit, paginateCalls, requestCalls } = makeOctokit({
      paginateItems: { [COMMITS_ROUTE]: commitItems(250, 'pr') },
      requestData: { [PULL_ROUTE]: { commits: 250 } },
    });

    const result = await listPrCommitMessages(octokit, pull);

    expect(result.complete).toBe(true);
    expect(result.totalCommits).toBe(250);
    expect(result.messages).toHaveLength(250);
    expect(result.messages[0]).toBe('pr-0');
    expect(requestCalls).toEqual([
      { route: PULL_ROUTE, params: { owner: 'acme', repo: 'widgets', pull_number: 7 } },
    ]);
    // No compare fallback needed.
    expect(paginateCalls.map((c) => c.route)).toEqual([COMMITS_ROUTE]);
  });

  it('uses the compare fallback when pulls.get reports more than 250 commits', async () => {
    const comparePages = [
      { url: 'https://api.github.test/compare?page=1', commits: commitItems(100, 'cmp-a') },
      { url: 'https://api.github.test/compare?page=2', commits: commitItems(100, 'cmp-b') },
      { url: 'https://api.github.test/compare?page=3', commits: commitItems(100, 'cmp-c') },
      { url: 'https://api.github.test/compare?page=4', commits: commitItems(100, 'cmp-d') },
    ];
    const { octokit, paginateCalls } = makeOctokit({
      paginateItems: { [COMMITS_ROUTE]: commitItems(250, 'pr'), [COMPARE_ROUTE]: comparePages },
      requestData: { [PULL_ROUTE]: { commits: 400 } },
    });

    const result = await listPrCommitMessages(octokit, pull);

    expect(result.complete).toBe(true);
    expect(result.totalCommits).toBe(400);
    expect(result.messages).toHaveLength(400);
    expect(result.messages[0]).toBe('cmp-a-0');
    expect(result.messages[399]).toBe('cmp-d-99');
    expect(paginateCalls[1]).toEqual({
      route: COMPARE_ROUTE,
      params: { owner: 'acme', repo: 'widgets', basehead: 'base000...head000', per_page: 100 },
    });
  });

  it('handles paginate already flattening compare pages into commit objects', async () => {
    const { octokit } = makeOctokit({
      paginateItems: { [COMMITS_ROUTE]: commitItems(250, 'pr'), [COMPARE_ROUTE]: commitItems(300, 'flat') },
      requestData: { [PULL_ROUTE]: { commits: 300 } },
    });

    const result = await listPrCommitMessages(octokit, pull);

    expect(result.complete).toBe(true);
    expect(result.totalCommits).toBe(300);
    expect(result.messages).toHaveLength(300);
    expect(result.messages[299]).toBe('flat-299');
  });

  it('fails closed when the compare fallback comes up short', async () => {
    const comparePages = [
      { commits: commitItems(100, 'cmp-a') },
      { commits: commitItems(100, 'cmp-b') },
      { commits: commitItems(100, 'cmp-c') },
    ];
    const { octokit } = makeOctokit({
      paginateItems: { [COMMITS_ROUTE]: commitItems(250, 'pr'), [COMPARE_ROUTE]: comparePages },
      requestData: { [PULL_ROUTE]: { commits: 400 } },
    });

    const result = await listPrCommitMessages(octokit, pull);

    expect(result.complete).toBe(false);
    expect(result.totalCommits).toBe(400);
    expect(result.messages).toHaveLength(300);
  });

  it('fails closed when pulls.get lacks a numeric commits count', async () => {
    const { octokit } = makeOctokit({
      paginateItems: { [COMMITS_ROUTE]: commitItems(250, 'pr') },
      requestData: { [PULL_ROUTE]: {} },
    });

    const result = await listPrCommitMessages(octokit, pull);

    expect(result.complete).toBe(false);
    expect(result.totalCommits).toBe(250);
  });
});
