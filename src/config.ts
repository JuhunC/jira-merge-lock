import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { JiraAuthMethod } from './types.js';

/** Thrown by loadConfig; `problems` lists every violation found (aggregated
 * so operators fix their .env in one pass, not one error at a time). */
export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export interface AppConfig {
  appId: number;
  webhookSecret: string;
  privateKey?: string;
  privateKeyPath?: string;
  port: number;
  /** Listen address. Default 0.0.0.0 — Probot's own default of "localhost"
   * makes a container's published port unreachable from outside. */
  host: string;
  logLevel: string;
  logFormat: 'json' | 'pretty';
  jira: {
    baseUrl: string; // normalized: no trailing slash
    authMethod: JiraAuthMethod;
    email?: string;
    apiToken?: string;
    pat?: string;
    username?: string;
    password?: string;
    timeoutMs: number;
  };
  /** lowercased + trimmed status names that count as done. */
  doneStatuses: string[];
  doneUseCategory: boolean;
  /** Regex SOURCE (no flags). Consumers construct their own RegExp (the `g`
   * flag is stateful — never share a compiled global regex). */
  keyRegexSource: string;
  /** Uppercased project-key allowlist; empty = all projects. */
  projectKeys: string[];
  requireIssueKey: boolean;
  rulesetNamePrefix: string;
  rulesetAutoconfigure: boolean;
  checkName: string;
  /** Minimum number of PR comments from someone OTHER than the PR author
   * required to merge. 0 (default) disables the comment check entirely. */
  minPrComments: number;
  /** Name of the second check run posted when minPrComments > 0.
   * Defaults to "<checkName>-comments". */
  commentCheckName: string;
  pollIntervalSeconds: number;
  pollConcurrency: number;
  /** Public base URL of this deployment (no trailing slash). Optional —
   * when set, check-run output links to the guidelines homepage. */
  publicUrl?: string;
  /** GitHub REST API root, e.g. "https://github.yourco.com/api/v3" for
   * GitHub Enterprise Server. Undefined = github.com. Derived from
   * GHE_HOST / GHE_PROTOCOL (Probot's convention). */
  githubBaseUrl?: string;
  /** Per-request timeout for GitHub API calls. Octokit has none by default —
   * a silently-dropping enterprise proxy/firewall would hang a poll cycle
   * forever (and the cycle mutex then blocks all future cycles). */
  githubTimeoutMs: number;
  /** Hash of every verdict-relevant setting; folded into check-run
   * fingerprints so a config change invalidates stale verdicts. */
  configHash: string;
}

const boolString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const DEFAULT_KEY_REGEX = '[A-Z][A-Z0-9]+-\\d+';

const envSchema = z.object({
  APP_ID: z.coerce.number().int().positive(),
  WEBHOOK_SECRET: z.string().min(1),
  PRIVATE_KEY: z.string().min(1).optional(),
  PRIVATE_KEY_PATH: z.string().min(1).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  JIRA_BASE_URL: z.string().min(1),
  JIRA_AUTH_METHOD: z.enum(['cloud', 'pat', 'basic']),
  JIRA_EMAIL: z.string().min(1).optional(),
  JIRA_API_TOKEN: z.string().min(1).optional(),
  JIRA_PAT: z.string().min(1).optional(),
  JIRA_USERNAME: z.string().min(1).optional(),
  JIRA_PASSWORD: z.string().min(1).optional(),
  JIRA_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  GITHUB_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  JIRA_DONE_STATUSES: z.string().default('Closed,Resolved'),
  JIRA_DONE_USE_CATEGORY: boolString.default(false),
  JIRA_KEY_REGEX: z.string().min(1).default(DEFAULT_KEY_REGEX),
  JIRA_PROJECT_KEYS: z.string().optional(),
  REQUIRE_ISSUE_KEY: boolString.default(false),
  RULESET_NAME_PREFIX: z.string().min(1).default('jira-merge-lock'),
  RULESET_AUTOCONFIGURE: boolString.default(true),
  CHECK_NAME: z.string().min(1).max(100).default('jira-merge-lock'),
  MIN_PR_COMMENTS: z.coerce.number().int().min(0).default(0),
  COMMENT_CHECK_NAME: z.string().min(1).max(100).optional(),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(300),
  POLL_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  PUBLIC_URL: z.string().min(1).optional(),
  GHE_HOST: z.string().min(1).optional(),
  GHE_PROTOCOL: z.enum(['https', 'http']).default('https'),
});

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const problems: string[] = [];

  // Pass only defined values so zod defaults apply to absent vars, and empty
  // strings (common .env accidents) are treated as absent.
  const input: Record<string, string> = {};
  for (const key of Object.keys(envSchema.shape)) {
    const v = env[key];
    if (v !== undefined && v !== '') input[key] = v;
  }

  const parsed = envSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = issue.path.join('.') || '(env)';
      problems.push(`${name}: ${issue.message}`);
    }
    // Cross-field checks below need parsed data; bail with what we have.
    throw new ConfigError(problems);
  }
  const e = parsed.data;

  if (!e.PRIVATE_KEY && !e.PRIVATE_KEY_PATH) {
    problems.push('PRIVATE_KEY or PRIVATE_KEY_PATH: exactly one is required (the GitHub App private key PEM, or a path to it)');
  }
  if (e.PRIVATE_KEY && e.PRIVATE_KEY_PATH) {
    problems.push('PRIVATE_KEY and PRIVATE_KEY_PATH: set exactly one, not both');
  }

  let jiraBaseUrl = e.JIRA_BASE_URL.replace(/\/+$/, '');
  try {
    const url = new URL(jiraBaseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      problems.push(`JIRA_BASE_URL: must be an http(s) URL, got "${e.JIRA_BASE_URL}"`);
    }
  } catch {
    problems.push(`JIRA_BASE_URL: not a valid URL: "${e.JIRA_BASE_URL}"`);
  }

  switch (e.JIRA_AUTH_METHOD) {
    case 'cloud':
      if (!e.JIRA_EMAIL) problems.push('JIRA_EMAIL: required when JIRA_AUTH_METHOD=cloud');
      if (!e.JIRA_API_TOKEN) problems.push('JIRA_API_TOKEN: required when JIRA_AUTH_METHOD=cloud');
      break;
    case 'pat':
      if (!e.JIRA_PAT) problems.push('JIRA_PAT: required when JIRA_AUTH_METHOD=pat (Jira Server/DC 8.14+ personal access token)');
      break;
    case 'basic':
      if (!e.JIRA_USERNAME) problems.push('JIRA_USERNAME: required when JIRA_AUTH_METHOD=basic');
      if (!e.JIRA_PASSWORD) problems.push('JIRA_PASSWORD: required when JIRA_AUTH_METHOD=basic');
      break;
  }

  try {
    // eslint-disable-next-line no-new
    new RegExp(e.JIRA_KEY_REGEX);
  } catch (err) {
    problems.push(`JIRA_KEY_REGEX: does not compile: ${(err as Error).message}`);
  }

  const doneStatuses = splitList(e.JIRA_DONE_STATUSES).map((s) => s.toLowerCase());
  if (doneStatuses.length === 0 && !e.JIRA_DONE_USE_CATEGORY) {
    problems.push('JIRA_DONE_STATUSES: must contain at least one status name (or enable JIRA_DONE_USE_CATEGORY)');
  }

  let publicUrl = e.PUBLIC_URL?.replace(/\/+$/, '');
  if (publicUrl !== undefined) {
    try {
      const url = new URL(publicUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        problems.push(`PUBLIC_URL: must be an http(s) URL, got "${e.PUBLIC_URL}"`);
      }
    } catch {
      problems.push(`PUBLIC_URL: not a valid URL: "${e.PUBLIC_URL}"`);
    }
  }

  // GHE_HOST accepts a bare hostname ("github.yourco.com") or a full URL
  // ("https://github.yourco.com") — both resolve to <proto>://<host>/api/v3.
  let githubBaseUrl: string | undefined;
  if (e.GHE_HOST) {
    let host = e.GHE_HOST.replace(/\/+$/, '');
    let proto: string = e.GHE_PROTOCOL;
    if (host.includes('://')) {
      try {
        const url = new URL(host);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
        if (url.pathname !== '/' && url.pathname !== '') throw new Error('unexpected path');
        proto = url.protocol.replace(':', '');
        host = url.host;
      } catch {
        problems.push(
          `GHE_HOST: expected a hostname like "github.yourco.com" (or https URL without a path), got "${e.GHE_HOST}"`,
        );
        host = '';
      }
    } else if (/[\s/]/.test(host)) {
      problems.push(`GHE_HOST: expected a hostname, got "${e.GHE_HOST}"`);
      host = '';
    }
    if (host) githubBaseUrl = `${proto}://${host}/api/v3`;
  }

  const projectKeys = splitList(e.JIRA_PROJECT_KEYS).map((s) => s.toUpperCase());
  for (const key of projectKeys) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      problems.push(`JIRA_PROJECT_KEYS: "${key}" is not a valid Jira project key`);
    }
  }

  // Two distinct check runs need two distinct names. The derived default can
  // exceed GitHub's 100-char check-name cap when CHECK_NAME is near it.
  const commentCheckName = e.COMMENT_CHECK_NAME ?? `${e.CHECK_NAME}-comments`;
  if (commentCheckName === e.CHECK_NAME) {
    problems.push('COMMENT_CHECK_NAME: must differ from CHECK_NAME (two separate check runs)');
  }
  if (commentCheckName.length > 100) {
    problems.push('COMMENT_CHECK_NAME: must be at most 100 characters (GitHub check-name limit)');
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const configHash = createHash('sha256')
    .update(
      JSON.stringify([
        e.CHECK_NAME,
        doneStatuses,
        e.JIRA_DONE_USE_CATEGORY,
        e.JIRA_KEY_REGEX,
        projectKeys,
        e.REQUIRE_ISSUE_KEY,
      ]),
    )
    .digest('hex')
    .slice(0, 16);

  return {
    appId: e.APP_ID,
    webhookSecret: e.WEBHOOK_SECRET,
    privateKey: e.PRIVATE_KEY,
    privateKeyPath: e.PRIVATE_KEY_PATH,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    logFormat: e.LOG_FORMAT,
    jira: {
      baseUrl: jiraBaseUrl,
      authMethod: e.JIRA_AUTH_METHOD,
      email: e.JIRA_EMAIL,
      apiToken: e.JIRA_API_TOKEN,
      pat: e.JIRA_PAT,
      username: e.JIRA_USERNAME,
      password: e.JIRA_PASSWORD,
      timeoutMs: e.JIRA_TIMEOUT_MS,
    },
    githubTimeoutMs: e.GITHUB_TIMEOUT_MS,
    doneStatuses,
    doneUseCategory: e.JIRA_DONE_USE_CATEGORY,
    keyRegexSource: e.JIRA_KEY_REGEX,
    projectKeys,
    requireIssueKey: e.REQUIRE_ISSUE_KEY,
    rulesetNamePrefix: e.RULESET_NAME_PREFIX,
    rulesetAutoconfigure: e.RULESET_AUTOCONFIGURE,
    checkName: e.CHECK_NAME,
    minPrComments: e.MIN_PR_COMMENTS,
    commentCheckName,
    pollIntervalSeconds: e.POLL_INTERVAL_SECONDS,
    pollConcurrency: e.POLL_CONCURRENCY,
    publicUrl,
    githubBaseUrl,
    configHash,
  };
}

/** A minimal valid env for tests; override per test case. */
export function testEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    APP_ID: '12345',
    WEBHOOK_SECRET: 'test-secret',
    PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
    JIRA_BASE_URL: 'https://jira.example.com',
    JIRA_AUTH_METHOD: 'cloud',
    JIRA_EMAIL: 'bot@example.com',
    JIRA_API_TOKEN: 'token-123',
    ...overrides,
  };
}
