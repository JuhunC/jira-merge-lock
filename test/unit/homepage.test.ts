import { describe, expect, it } from 'vitest';
import { loadConfig, testEnv } from '../../src/config.js';
import { renderHomepage } from '../../src/homepage.js';

describe('renderHomepage', () => {
  it('returns a complete html document', () => {
    const html = renderHomepage(loadConfig(testEnv()));
    expect(html.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
  });

  it('renders check name, ruleset prefix convention, done statuses, and poll interval', () => {
    const html = renderHomepage(
      loadConfig(
        testEnv({
          CHECK_NAME: 'my-jira-check',
          RULESET_NAME_PREFIX: 'lock-rules',
          JIRA_DONE_STATUSES: 'Closed,Resolved,Done',
        }),
      ),
    );
    expect(html).toContain('my-jira-check');
    expect(html).toContain('lock-rules*');
    expect(html).toContain('closed');
    expect(html).toContain('resolved');
    expect(html).toContain('done');
    expect(html).toContain('300 seconds');
  });

  it('renders the key regex source and the project allowlist when set', () => {
    const html = renderHomepage(
      loadConfig(testEnv({ JIRA_PROJECT_KEYS: 'PRJ,OPS' })),
    );
    expect(html).toContain('[A-Z][A-Z0-9]+-\\d+');
    expect(html).toContain('PRJ');
    expect(html).toContain('OPS');
  });

  it('mentions category mode when doneUseCategory is enabled', () => {
    const off = renderHomepage(loadConfig(testEnv()));
    const on = renderHomepage(loadConfig(testEnv({ JIRA_DONE_USE_CATEGORY: 'true' })));
    expect(on).toContain('status category');
    expect(off).not.toContain('status category');
  });

  it('reflects requireIssueKey=true (zero-key PRs blocked)', () => {
    const html = renderHomepage(loadConfig(testEnv({ REQUIRE_ISSUE_KEY: 'true' })));
    expect(html).toContain('must reference at least one Jira issue key');
    expect(html).not.toContain('passes this check automatically');
  });

  it('reflects requireIssueKey=false (zero-key PRs pass)', () => {
    const html = renderHomepage(loadConfig(testEnv({ REQUIRE_ISSUE_KEY: 'false' })));
    expect(html).toContain('passes this check automatically');
    expect(html).not.toContain('must reference at least one Jira issue key');
  });

  it('describes the comment gate only when MIN_PR_COMMENTS > 0', () => {
    const off = renderHomepage(loadConfig(testEnv()));
    expect(off).not.toContain('Required discussion');

    const on = renderHomepage(loadConfig(testEnv({ MIN_PR_COMMENTS: '2' })));
    expect(on).toContain('Required discussion');
    expect(on).toContain('2 comments from someone other than its author');
    expect(on).toContain('jira-merge-lock-comments');
  });

  it('never leaks secrets, Jira config, or the app id', () => {
    const html = renderHomepage(loadConfig(testEnv()));
    for (const secret of [
      'test-secret',
      'token-123',
      'bot@example.com',
      'jira.example.com',
      'BEGIN RSA',
      '12345',
    ]) {
      expect(html).not.toContain(secret);
    }
  });

  it('contains no client JS or external resources', () => {
    const html = renderHomepage(loadConfig(testEnv()));
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('html-escapes the key regex source', () => {
    const html = renderHomepage(
      loadConfig(testEnv({ JIRA_KEY_REGEX: '(?<!x)[A-Z][A-Z0-9]+-\\d+' })),
    );
    expect(html).not.toContain('(?<!x)');
    expect(html).toContain('(?&lt;!x)');
  });
});
