import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, testEnv } from '../../src/config.js';

describe('loadConfig', () => {
  it('parses a minimal cloud config with defaults', () => {
    const cfg = loadConfig(testEnv());
    expect(cfg.appId).toBe(12345);
    expect(cfg.jira.authMethod).toBe('cloud');
    expect(cfg.doneStatuses).toEqual(['closed', 'resolved']);
    expect(cfg.doneUseCategory).toBe(false);
    expect(cfg.requireIssueKey).toBe(false);
    expect(cfg.rulesetNamePrefix).toBe('jira-merge-lock');
    expect(cfg.rulesetAutoconfigure).toBe(true);
    expect(cfg.checkName).toBe('jira-merge-lock');
    expect(cfg.pollIntervalSeconds).toBe(300);
    expect(cfg.pollConcurrency).toBe(5);
    expect(cfg.port).toBe(3000);
    expect(cfg.keyRegexSource).toBe('[A-Z][A-Z0-9]+-\\d+');
    expect(cfg.projectKeys).toEqual([]);
  });

  it('aggregates every problem into one error', () => {
    const env = testEnv({
      JIRA_EMAIL: undefined,
      JIRA_API_TOKEN: undefined,
      JIRA_KEY_REGEX: '[unclosed',
    });
    try {
      loadConfig(env);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const problems = (err as ConfigError).problems.join('\n');
      expect(problems).toContain('JIRA_EMAIL');
      expect(problems).toContain('JIRA_API_TOKEN');
      expect(problems).toContain('JIRA_KEY_REGEX');
    }
  });

  it('requires JIRA_PAT for pat mode', () => {
    expect(() => loadConfig(testEnv({ JIRA_AUTH_METHOD: 'pat' }))).toThrowError(/JIRA_PAT/);
    const cfg = loadConfig(testEnv({ JIRA_AUTH_METHOD: 'pat', JIRA_PAT: 'pat-token' }));
    expect(cfg.jira.pat).toBe('pat-token');
  });

  it('requires username+password for basic mode', () => {
    expect(() => loadConfig(testEnv({ JIRA_AUTH_METHOD: 'basic' }))).toThrowError(/JIRA_USERNAME[\s\S]*JIRA_PASSWORD/);
    const cfg = loadConfig(
      testEnv({ JIRA_AUTH_METHOD: 'basic', JIRA_USERNAME: 'u', JIRA_PASSWORD: 'p' }),
    );
    expect(cfg.jira.username).toBe('u');
  });

  it('rejects unknown auth methods', () => {
    expect(() => loadConfig(testEnv({ JIRA_AUTH_METHOD: 'oauth' }))).toThrowError(/JIRA_AUTH_METHOD/);
  });

  it('requires exactly one of PRIVATE_KEY / PRIVATE_KEY_PATH', () => {
    expect(() => loadConfig(testEnv({ PRIVATE_KEY: undefined }))).toThrowError(/PRIVATE_KEY/);
    expect(() =>
      loadConfig(testEnv({ PRIVATE_KEY_PATH: '/keys/app.pem' })),
    ).toThrowError(/not both/);
    const cfg = loadConfig(testEnv({ PRIVATE_KEY: undefined, PRIVATE_KEY_PATH: '/keys/app.pem' }));
    expect(cfg.privateKeyPath).toBe('/keys/app.pem');
  });

  it('normalizes the Jira base URL and done statuses', () => {
    const cfg = loadConfig(
      testEnv({
        JIRA_BASE_URL: 'https://jira.corp.local/',
        JIRA_DONE_STATUSES: ' Done , Released ,',
      }),
    );
    expect(cfg.jira.baseUrl).toBe('https://jira.corp.local');
    expect(cfg.doneStatuses).toEqual(['done', 'released']);
  });

  it('rejects non-http(s) Jira URLs', () => {
    expect(() => loadConfig(testEnv({ JIRA_BASE_URL: 'ftp://jira.example.com' }))).toThrowError(
      /JIRA_BASE_URL/,
    );
    expect(() => loadConfig(testEnv({ JIRA_BASE_URL: 'not a url' }))).toThrowError(/JIRA_BASE_URL/);
  });

  it('parses booleans and lists', () => {
    const cfg = loadConfig(
      testEnv({
        REQUIRE_ISSUE_KEY: 'yes',
        RULESET_AUTOCONFIGURE: 'false',
        JIRA_DONE_USE_CATEGORY: '1',
        JIRA_PROJECT_KEYS: 'prj, ops',
      }),
    );
    expect(cfg.requireIssueKey).toBe(true);
    expect(cfg.rulesetAutoconfigure).toBe(false);
    expect(cfg.doneUseCategory).toBe(true);
    expect(cfg.projectKeys).toEqual(['PRJ', 'OPS']);
  });

  it('rejects garbage booleans and invalid project keys', () => {
    expect(() => loadConfig(testEnv({ REQUIRE_ISSUE_KEY: 'maybe' }))).toThrowError(/REQUIRE_ISSUE_KEY/);
    expect(() => loadConfig(testEnv({ JIRA_PROJECT_KEYS: '1BAD' }))).toThrowError(/JIRA_PROJECT_KEYS/);
  });

  it('treats empty strings as absent (defaults apply)', () => {
    const cfg = loadConfig(testEnv({ CHECK_NAME: '' }));
    expect(cfg.checkName).toBe('jira-merge-lock');
  });

  it('configHash is stable and changes with verdict-relevant settings', () => {
    const a = loadConfig(testEnv());
    const b = loadConfig(testEnv());
    const c = loadConfig(testEnv({ JIRA_DONE_STATUSES: 'Done' }));
    const d = loadConfig(testEnv({ POLL_INTERVAL_SECONDS: '60' }));
    expect(a.configHash).toBe(b.configHash);
    expect(a.configHash).not.toBe(c.configHash);
    expect(a.configHash).toBe(d.configHash); // poll interval does not affect verdicts
  });
});
