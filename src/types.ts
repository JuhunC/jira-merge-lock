/**
 * Shared types and cross-module contracts for jira-merge-lock.
 *
 * Module map (each module's exports are specified in its own file; the data
 * shapes they exchange live here):
 *
 *   config.ts    loadConfig(env) -> AppConfig (throws ConfigError listing ALL problems)
 *   extract.ts   extractJiraKeys(messages, cfg) -> string[]            (pure)
 *   jira.ts      JiraClient: getIssueStatuses(keys, cache?) -> JiraIssueOutcome[]
 *   evaluate.ts  buildVerdictFromOutcomes / buildErrorVerdict -> Verdict (pure)
 *   commits.ts   listPrCommitMessages(octokit, pull) -> CommitListing
 *   checks.ts    findLatestCheckRun / postCheckRun / postSkippedRun
 *   rulesets.ts  injectRequiredCheck (pure), discoverPrefixRulesets,
 *                isInScope, autoconfigureOrg, repoCouldMatch, ScopeCache
 *   pipeline.ts  evaluatePullRequest(deps, pull, trigger) — the single
 *                evaluation path shared by webhook handlers and the poller
 *   poller.ts    createPoller(deps) -> { start, stop, runOnce }
 *   homepage.ts  renderHomepage(cfg) -> string (HTML; no secrets)
 *   index.ts     Probot app function (webhook wiring)
 *   main.ts      bootstrap: config -> Probot Server + routes -> poller
 */

/** Narrow structural view of an authenticated Octokit. Modules depend on this
 * instead of the full Probot/Octokit types so unit tests can pass plain
 * objects. `request` mirrors octokit.request("GET /path", params) and
 * `paginate` mirrors octokit.paginate("GET /path", params) -> all items. */
export interface OctokitLike {
  request(
    route: string,
    parameters?: Record<string, unknown>,
  ): Promise<{ data: any; status: number; headers: Record<string, string | undefined> }>;
  paginate(route: string, parameters?: Record<string, unknown>): Promise<any[]>;
}

/** Minimal structural logger (satisfied by pino / probot's context.log). */
export interface LoggerLike {
  debug(obj: object | string, msg?: string): void;
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
  child?(bindings: object): LoggerLike;
}

export type JiraAuthMethod = 'cloud' | 'pat' | 'basic';

/** Per-issue result of a Jira lookup. Transport-level failures are NOT
 * outcomes — JiraClient throws JiraUnavailableError / JiraAuthError instead. */
export type JiraIssueOutcome =
  | { key: string; outcome: 'found'; statusName: string; statusCategoryKey: string | null }
  | { key: string; outcome: 'not_found' } // 404 — regex false positives land here; non-blocking
  | { key: string; outcome: 'forbidden' }; // 403 or 200-without-status-field; BLOCKING (cannot verify)

/** Jira is unreachable / rate-limit-exhausted. Carries no information about
 * issue state — callers apply the keep-last-verdict / fail-closed-on-new-SHA
 * policy. */
export class JiraUnavailableError extends Error {
  constructor(
    message: string,
    public readonly kind: 'unreachable' | 'rate_limited' | 'timeout' = 'unreachable',
  ) {
    super(message);
    this.name = 'JiraUnavailableError';
  }
}

/** Jira rejected our credentials (401, or 403 on the auth probe). This is a
 * configuration failure, not an outage — logged at error, surfaced on /readyz. */
export class JiraAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraAuthError';
  }
}

export interface EvaluatedIssue {
  key: string;
  /** Jira status name, or null when not found / forbidden / unverified. */
  statusName: string | null;
  blocking: boolean;
  /** Human-readable cell for the check-run table, e.g. "In Progress",
   * "not found (ignored)", "access denied — cannot verify". */
  note: string;
}

export interface Verdict {
  conclusion: 'success' | 'failure';
  issues: EvaluatedIssue[];
  /** Check-run output title, e.g. "Blocked: 2 of 3 Jira issues not done". */
  title: string;
  /** Markdown summary (table of issues + footer). MUST be <= 60_000 chars —
   * renderer truncates with "…and N more issues" (API caps at 65_535). */
  summary: string;
  /** sha256 hex of (conclusion + sorted KEY=status pairs + cfg.configHash).
   * Stored as the check run's external_id; equal fingerprint => skip write. */
  fingerprint: string;
}

/** Everything the pipeline needs to evaluate one pull request. */
export interface PullRef {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  baseRef: string; // base branch name WITHOUT "refs/heads/" prefix
  baseSha: string;
}

export interface CommitListing {
  messages: string[];
  /** false when the commit list could not be fully enumerated (e.g. >250
   * commits and the compare fallback was also truncated) — fail closed. */
  complete: boolean;
  totalCommits: number;
}

/** A GitHub org ruleset as returned by GET /orgs/{org}/rulesets/{id}.
 * Only the fields we read/write are modeled; everything else is passed
 * through untouched via [key: string]. */
export interface OrgRuleset {
  id: number;
  name: string;
  target?: string; // "branch" | "tag" | "push" | ...
  enforcement?: string; // "active" | "evaluate" | "disabled"
  conditions?: {
    ref_name?: { include?: string[]; exclude?: string[] };
    repository_name?: { include?: string[]; exclude?: string[]; protected?: boolean };
    repository_id?: { repository_ids?: number[] };
    repository_property?: unknown;
    [key: string]: unknown;
  };
  rules?: RulesetRule[];
  [key: string]: unknown;
}

export interface RulesetRule {
  type: string; // we only ever modify type === "required_status_checks"
  parameters?: {
    required_status_checks?: Array<{ context: string; integration_id?: number }>;
    strict_required_status_checks_policy?: boolean;
    do_not_enforce_on_create?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type EvaluationTrigger = 'webhook' | 'poll' | 'rerequest' | 'merge_group';

/** Per-poll-cycle shared state: memoizes Jira lookups across PRs so N PRs
 * referencing the same key cost one Jira call per cycle. */
export type JiraCycleCache = Map<string, JiraIssueOutcome>;
