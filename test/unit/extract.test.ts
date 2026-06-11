import { describe, expect, it } from 'vitest';
import { loadConfig, testEnv } from '../../src/config.js';
import { extractJiraKeys } from '../../src/extract.js';

const defaults = loadConfig(testEnv());

describe('extractJiraKeys', () => {
  it('finds multiple keys in one message, deduped and sorted', () => {
    const keys = extractJiraKeys(['PRJ-2 fixes OPS-30, follow-up to PRJ-1 (PRJ-2 again)'], defaults);
    expect(keys).toEqual(['OPS-30', 'PRJ-1', 'PRJ-2']);
  });

  it('dedupes across commit messages', () => {
    const keys = extractJiraKeys(['PRJ-1: start work', 'PRJ-1: address review', 'PRJ-7 and PRJ-1'], defaults);
    expect(keys).toEqual(['PRJ-1', 'PRJ-7']);
  });

  it('does not match lowercase tokens with the default regex', () => {
    const keys = extractJiraKeys(['prj-123 fix typo', 'see Prj-9'], defaults);
    expect(keys).toEqual([]);
  });

  it('matches UTF-8 and SHA-256 with the default regex (known false positives)', () => {
    // The default pattern cannot distinguish Jira keys from terms like
    // UTF-8 / SHA-256. This is accepted: downstream treats a Jira 404 as
    // non-blocking "not found (ignored)", and JIRA_PROJECT_KEYS is the
    // precision knob (next test).
    const keys = extractJiraKeys(['Switch to UTF-8 encoding', 'Use SHA-256 for digests'], defaults);
    expect(keys).toEqual(['SHA-256', 'UTF-8']);
  });

  it('projectKeys allowlist filters by prefix before the last hyphen', () => {
    const cfg = loadConfig(testEnv({ JIRA_PROJECT_KEYS: 'PRJ,OPS' }));
    const keys = extractJiraKeys(['PRJ-1 uses UTF-8 and SHA-256, blocks OPS-2 and QA-3'], cfg);
    expect(keys).toEqual(['OPS-2', 'PRJ-1']);
  });

  it('supports a custom keyRegexSource and uppercases matches', () => {
    const cfg = loadConfig(testEnv({ JIRA_KEY_REGEX: '(?:prj|ops)-\\d+' }));
    const keys = extractJiraKeys(['prj-12 done, ops-3 pending', 'PRJ-12 again'], cfg);
    expect(keys).toEqual(['OPS-3', 'PRJ-12']);
  });

  it('returns [] for empty input and for messages without keys', () => {
    expect(extractJiraKeys([], defaults)).toEqual([]);
    expect(extractJiraKeys(['chore: bump deps', ''], defaults)).toEqual([]);
  });

  it('is stateless across calls (no shared lastIndex)', () => {
    const msgs = ['PRJ-1 PRJ-2'];
    expect(extractJiraKeys(msgs, defaults)).toEqual(extractJiraKeys(msgs, defaults));
  });
});
