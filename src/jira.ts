import type { AppConfig } from './config.js';
import { JiraAuthError, JiraUnavailableError } from './types.js';
import type { JiraCycleCache, JiraIssueOutcome, LoggerLike } from './types.js';

const BATCH_THRESHOLD = 20;
const BATCH_CHUNK_SIZE = 100;
/**
 * Strict Jira key grammar a key must satisfy before it may enter a batch
 * request. Extraction uses the operator-configurable JIRA_KEY_REGEX, so an
 * extracted "key" can contain arbitrary characters; only keys matching this
 * shape are ever inlined into JQL. Everything else is resolved through the
 * per-key GET path, which percent-encodes the key — JQL injection is
 * impossible regardless of how the operator configures the extraction regex.
 */
const SAFE_BATCH_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const MAX_CONCURRENCY = 5;
const MAX_RETRY_AFTER_SECONDS = 30;
const DEFAULT_RETRY_AFTER_SECONDS = 5;

export function authHeader(jira: AppConfig['jira']): string {
  switch (jira.authMethod) {
    case 'cloud':
      return 'Basic ' + Buffer.from(`${jira.email}:${jira.apiToken}`).toString('base64');
    case 'pat':
      return `Bearer ${jira.pat}`;
    case 'basic':
      return 'Basic ' + Buffer.from(`${jira.username}:${jira.password}`).toString('base64');
  }
}

interface JiraStatusJson {
  name?: unknown;
  statusCategory?: { key?: unknown };
}

interface JiraIssueJson {
  key?: unknown;
  fields?: { status?: JiraStatusJson };
}

const noopLogger: LoggerLike = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export class JiraClient {
  private readonly cfg: AppConfig;
  private readonly log: LoggerLike;
  private readonly baseHeaders: Record<string, string>;

  constructor(cfg: AppConfig, opts?: { logger?: LoggerLike }) {
    this.cfg = cfg;
    this.log = opts?.logger ?? noopLogger;
    this.baseHeaders = {
      authorization: authHeader(cfg.jira),
      accept: 'application/json',
    };
  }

  async getIssueStatuses(keys: string[], cache?: JiraCycleCache): Promise<JiraIssueOutcome[]> {
    const distinct = [...new Set(keys)];
    const resolved = new Map<string, JiraIssueOutcome>();
    const uncached: string[] = [];
    for (const key of distinct) {
      const hit = cache?.get(key);
      if (hit) resolved.set(key, hit);
      else uncached.push(key);
    }

    let remaining = uncached;
    if (uncached.length > BATCH_THRESHOLD) {
      // Only strictly-shaped keys may enter batch requests (JQL / bulkfetch
      // bodies); odd-shaped keys fall through to the per-key GET path below.
      const batchable = uncached.filter((key) => SAFE_BATCH_KEY.test(key));
      const batched = await this.batchFetch(batchable);
      for (const [key, outcome] of batched) resolved.set(key, outcome);
      // Keys the batch did not resolve (missing from results, or left over after
      // a batch failure) get per-key GETs — distinguishes 404 from 403.
      remaining = uncached.filter((k) => !resolved.has(k));
    }

    const fetched = await pool(remaining, MAX_CONCURRENCY, (key) => this.fetchIssue(key));
    for (const outcome of fetched) resolved.set(outcome.key, outcome);

    if (cache) {
      for (const key of uncached) {
        const outcome = resolved.get(key);
        if (outcome) cache.set(key, outcome);
      }
    }

    return distinct.map((key) => resolved.get(key) as JiraIssueOutcome);
  }

  async probe(): Promise<void> {
    const res = await this.send('GET', '/rest/api/2/myself');
    if (res.status === 403) {
      throw new JiraAuthError('Jira auth probe rejected (403): credentials lack API access');
    }
    if (!res.ok) {
      throw new JiraUnavailableError(`Jira auth probe failed with status ${res.status}`);
    }
  }

  private async fetchIssue(key: string): Promise<JiraIssueOutcome> {
    const res = await this.send('GET', `/rest/api/2/issue/${encodeURIComponent(key)}?fields=status`);
    if (res.status === 404) return { key, outcome: 'not_found' };
    if (res.status === 403) return { key, outcome: 'forbidden' };
    if (!res.ok) {
      throw new JiraUnavailableError(`Jira returned ${res.status} for issue ${key}`);
    }
    const data = (await parseJson(res)) as JiraIssueJson;
    return mapIssue(key, data);
  }

  /** Returns outcomes for the keys the batch endpoints resolved; throws only
   * on auth failure — any other batch error degrades to per-key lookups. */
  private async batchFetch(keys: string[]): Promise<Map<string, JiraIssueOutcome>> {
    const out = new Map<string, JiraIssueOutcome>();
    const wanted = new Set(keys);
    try {
      for (let i = 0; i < keys.length; i += BATCH_CHUNK_SIZE) {
        const chunk = keys.slice(i, i + BATCH_CHUNK_SIZE);
        const issues =
          this.cfg.jira.authMethod === 'cloud'
            ? await this.bulkFetchChunk(chunk)
            : await this.searchChunk(chunk);
        for (const issue of issues) {
          const key = typeof issue.key === 'string' ? issue.key : undefined;
          if (!key || !wanted.has(key)) continue;
          out.set(key, mapIssue(key, issue));
        }
      }
    } catch (err) {
      if (err instanceof JiraAuthError) throw err;
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err), keys: keys.length, resolved: out.size },
        'jira batch fetch failed; falling back to per-key lookups',
      );
    }
    return out;
  }

  private async bulkFetchChunk(chunk: string[]): Promise<JiraIssueJson[]> {
    const res = await this.send('POST', '/rest/api/3/issue/bulkfetch', {
      issueIdsOrKeys: chunk,
      fields: ['status'],
    });
    if (!res.ok) {
      throw new JiraUnavailableError(`Jira bulkfetch returned ${res.status}`);
    }
    const data = (await parseJson(res)) as { issues?: unknown };
    return Array.isArray(data.issues) ? (data.issues as JiraIssueJson[]) : [];
  }

  private async searchChunk(chunk: string[]): Promise<JiraIssueJson[]> {
    // Every key here has passed SAFE_BATCH_KEY — safe to inline in JQL.
    const jql = `issuekey in (${chunk.join(',')})`;
    const issues: JiraIssueJson[] = [];
    for (;;) {
      const res = await this.send('POST', '/rest/api/2/search', {
        jql,
        fields: ['status'],
        // Server/DC documents this POST field as a boolean. false suppresses
        // whole-query rejection when a listed key does not exist; missing keys
        // get the per-key follow-up, which yields exact 404/403 semantics.
        validateQuery: false,
        maxResults: BATCH_CHUNK_SIZE,
        startAt: issues.length,
      });
      if (!res.ok) {
        throw new JiraUnavailableError(`Jira search returned ${res.status}`);
      }
      const data = (await parseJson(res)) as { issues?: unknown; total?: unknown };
      const page = Array.isArray(data.issues) ? (data.issues as JiraIssueJson[]) : [];
      issues.push(...page);
      const total = typeof data.total === 'number' ? data.total : issues.length;
      if (page.length === 0 || issues.length >= total) return issues;
    }
  }

  private async send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const url = this.cfg.jira.baseUrl + path;
    const headers: Record<string, string> = { ...this.baseHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.cfg.jira.timeoutMs),
        });
      } catch (err) {
        throw toUnavailable(err, method, path);
      }

      if (res.status === 401) {
        // Never retry 401: repeated bad logins trip Jira Server's CAPTCHA lockout.
        throw new JiraAuthError(`Jira rejected credentials (401) on ${method} ${path}`);
      }
      if (res.status === 429) {
        if (attempt > 0) {
          throw new JiraUnavailableError(
            `Jira rate limit persisted after retry on ${method} ${path}`,
            'rate_limited',
          );
        }
        await sleep(retryAfterMs(res.headers.get('retry-after')));
        continue;
      }
      return res;
    }
  }
}

function mapIssue(key: string, issue: JiraIssueJson): JiraIssueOutcome {
  const status = issue.fields?.status;
  const name = typeof status?.name === 'string' ? status.name : undefined;
  if (name === undefined) {
    // 200 without a readable status = field-level permission gap → cannot verify.
    return { key, outcome: 'forbidden' };
  }
  const categoryKey = status?.statusCategory?.key;
  return {
    key,
    outcome: 'found',
    statusName: name,
    statusCategoryKey: typeof categoryKey === 'string' ? categoryKey : null,
  };
}

function retryAfterMs(header: string | null): number {
  const seconds = header === null ? NaN : Number(header);
  const waitSeconds =
    Number.isFinite(seconds) && seconds >= 0
      ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS)
      : DEFAULT_RETRY_AFTER_SECONDS;
  return waitSeconds * 1000;
}

function toUnavailable(err: unknown, method: string, path: string): JiraUnavailableError {
  const name = (err as { name?: string } | null)?.name;
  const cause = (err as { cause?: unknown } | null)?.cause;
  const causeName = (cause as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || causeName === 'TimeoutError' || name === 'AbortError') {
    return new JiraUnavailableError(`Jira request timed out on ${method} ${path}`, 'timeout');
  }
  const detail =
    cause instanceof Error ? cause.message : err instanceof Error ? err.message : String(err);
  return new JiraUnavailableError(`Jira unreachable on ${method} ${path}: ${detail}`, 'unreachable');
}

async function parseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new JiraUnavailableError(`Jira returned unparseable JSON (status ${res.status})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i] as T);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
