import { describe, expect, it } from 'vitest';
import { loadConfig, testEnv } from '../../src/config.js';
import { buildErrorVerdict, buildVerdictFromOutcomes } from '../../src/evaluate.js';
import type { JiraIssueOutcome } from '../../src/types.js';

const cfg = loadConfig(testEnv()); // doneStatuses: ['closed', 'resolved']
const categoryCfg = loadConfig(testEnv({ JIRA_DONE_USE_CATEGORY: 'true' }));

function found(
  key: string,
  statusName: string,
  statusCategoryKey: string | null = null,
): JiraIssueOutcome {
  return { key, outcome: 'found', statusName, statusCategoryKey };
}

describe('buildVerdictFromOutcomes — verdict matrix', () => {
  it('passes when all issues are done', () => {
    const v = buildVerdictFromOutcomes(
      [found('PRJ-1', 'Closed'), found('PRJ-2', 'Resolved')],
      cfg,
      { commitCount: 3 },
    );
    expect(v.conclusion).toBe('success');
    expect(v.title).toBe('All 2 Jira issues done');
    expect(v.issues.every((i) => !i.blocking)).toBe(true);
  });

  it('fails when one issue is not done', () => {
    const v = buildVerdictFromOutcomes(
      [found('PRJ-1', 'Closed'), found('PRJ-2', 'In Progress')],
      cfg,
      { commitCount: 2 },
    );
    expect(v.conclusion).toBe('failure');
    expect(v.title).toBe('Blocked: 1 of 2 Jira issues not done');
    const blocked = v.issues.find((i) => i.key === 'PRJ-2');
    expect(blocked?.blocking).toBe(true);
    expect(blocked?.note).toBe('In Progress');
  });

  it('matches done statuses case-insensitively', () => {
    const v = buildVerdictFromOutcomes([found('PRJ-1', 'CLOSED')], cfg, { commitCount: 1 });
    expect(v.conclusion).toBe('success');
  });

  it('trims status names before matching', () => {
    const v = buildVerdictFromOutcomes([found('PRJ-1', '  Resolved  ')], cfg, { commitCount: 1 });
    expect(v.conclusion).toBe('success');
    expect(v.issues[0]!.statusName).toBe('Resolved');
    expect(v.issues[0]!.note).toBe('Resolved');
  });

  it('records the status name as the issue note', () => {
    const v = buildVerdictFromOutcomes([found('PRJ-9', 'Code Review')], cfg, { commitCount: 1 });
    expect(v.issues[0]!.note).toBe('Code Review');
    expect(v.issues[0]!.statusName).toBe('Code Review');
  });
});

describe('buildVerdictFromOutcomes — status category opt-in', () => {
  it('blocks a done-category status with a non-listed name when category mode is off', () => {
    const v = buildVerdictFromOutcomes([found('PRJ-1', 'Fertig', 'done')], cfg, {
      commitCount: 1,
    });
    expect(v.conclusion).toBe('failure');
  });

  it('passes a done-category status with a non-listed name when category mode is on', () => {
    const v = buildVerdictFromOutcomes([found('PRJ-1', 'Fertig', 'done')], categoryCfg, {
      commitCount: 1,
    });
    expect(v.conclusion).toBe('success');
  });

  it('still blocks non-done categories with non-listed names when category mode is on', () => {
    const v = buildVerdictFromOutcomes([found('PRJ-1', 'In Progress', 'indeterminate')], categoryCfg, {
      commitCount: 1,
    });
    expect(v.conclusion).toBe('failure');
  });

  it('still honors listed status names when category mode is on', () => {
    const v = buildVerdictFromOutcomes([found('PRJ-1', 'Closed', 'indeterminate')], categoryCfg, {
      commitCount: 1,
    });
    expect(v.conclusion).toBe('success');
  });
});

describe('buildVerdictFromOutcomes — non-found outcomes', () => {
  it('blocks forbidden issues (fail closed)', () => {
    const v = buildVerdictFromOutcomes(
      [found('PRJ-1', 'Closed'), { key: 'SEC-1', outcome: 'forbidden' }],
      cfg,
      { commitCount: 1 },
    );
    expect(v.conclusion).toBe('failure');
    const sec = v.issues.find((i) => i.key === 'SEC-1');
    expect(sec?.blocking).toBe(true);
    expect(sec?.statusName).toBeNull();
    expect(sec?.note).toBe('access denied — cannot verify');
  });

  it('ignores not-found issues (regex false positives)', () => {
    const v = buildVerdictFromOutcomes(
      [found('PRJ-1', 'Closed'), { key: 'UTF-8', outcome: 'not_found' }],
      cfg,
      { commitCount: 1 },
    );
    expect(v.conclusion).toBe('success');
    const nf = v.issues.find((i) => i.key === 'UTF-8');
    expect(nf?.blocking).toBe(false);
    expect(nf?.statusName).toBeNull();
    expect(nf?.note).toBe('not found (ignored)');
  });
});

describe('buildVerdictFromOutcomes — zero outcomes', () => {
  it('passes by default', () => {
    const v = buildVerdictFromOutcomes([], cfg, { commitCount: 4 });
    expect(v.conclusion).toBe('success');
    expect(v.title).toBe('No Jira issues referenced');
    expect(v.issues).toEqual([]);
    expect(v.summary).toContain('Scanned 4 commit messages.');
  });

  it('fails when REQUIRE_ISSUE_KEY=true', () => {
    const strict = loadConfig(testEnv({ REQUIRE_ISSUE_KEY: 'true' }));
    const v = buildVerdictFromOutcomes([], strict, { commitCount: 4 });
    expect(v.conclusion).toBe('failure');
    expect(v.title).toBe('No Jira issues referenced — at least one issue key is required');
    expect(v.summary).toContain('REQUIRE_ISSUE_KEY');
  });
});

describe('buildVerdictFromOutcomes — summary rendering', () => {
  it('renders a markdown table with browse links and footer lines', () => {
    const v = buildVerdictFromOutcomes(
      [found('PRJ-1', 'In Progress'), found('PRJ-2', 'Closed')],
      cfg,
      { commitCount: 7 },
    );
    expect(v.summary).toContain('| Issue | Status | Blocking |');
    expect(v.summary).toContain('[PRJ-1](https://jira.example.com/browse/PRJ-1)');
    expect(v.summary).toContain('[PRJ-2](https://jira.example.com/browse/PRJ-2)');
    expect(v.summary).toContain('| In Progress | ❌ Yes |');
    expect(v.summary).toContain('| Closed | ✅ No |');
    expect(v.summary).toContain('`closed`');
    expect(v.summary).toContain('`resolved`');
    expect(v.summary).toContain('Scanned 7 commit messages.');
    expect(v.summary).toContain(
      'Close/resolve the issues in Jira, then re-run this check — or wait for the automatic re-check.',
    );
  });

  it('truncates huge issue lists at 60000 chars, keeping title and footer', () => {
    const outcomes = Array.from({ length: 2000 }, (_, i) =>
      found(`TRUNC-${i}`, 'Waiting For Code Review Stage'),
    );
    const v = buildVerdictFromOutcomes(outcomes, cfg, { commitCount: 2000 });
    expect(v.summary.length).toBeLessThanOrEqual(60_000);
    expect(v.summary).toMatch(/…and \d+ more issues/);
    expect(v.summary).toContain('[TRUNC-0](https://jira.example.com/browse/TRUNC-0)');
    expect(v.summary).toContain('Scanned 2000 commit messages.');
    expect(v.summary.endsWith('or wait for the automatic re-check.')).toBe(true);
    expect(v.title).toBe('Blocked: 2000 of 2000 Jira issues not done');
    // All issues stay in the structured verdict; only the markdown is cut.
    expect(v.issues).toHaveLength(2000);
  });
});

describe('summary rendering — markdown injection hardening', () => {
  it('escapes markdown metacharacters in hostile status names', () => {
    const v = buildVerdictFromOutcomes(
      [found('PRJ-1', 'Done](https://evil.example/phish)[')],
      cfg,
      { commitCount: 1 },
    );
    expect(v.summary).toContain('Done\\]\\(https://evil.example/phish\\)\\[');
    expect(v.summary).not.toContain('](https://evil.example');
  });

  it('escapes pipes in status names so cells cannot spill into new columns', () => {
    const v = buildVerdictFromOutcomes([found('PRJ-1', 'Open | forged | ✅ No')], cfg, {
      commitCount: 1,
    });
    expect(v.summary).toContain('| Open \\| forged \\| ✅ No |');
    const dataRows = v.summary.split('\n').filter((l) => l.includes('PRJ-1'));
    expect(dataRows).toHaveLength(1);
  });

  it('neutralizes control characters so a status cannot forge a table row', () => {
    const v = buildVerdictFromOutcomes(
      [found('PRJ-1', 'Done\n| FORGED-1 | Done | ✅ No |')],
      cfg,
      { commitCount: 1 },
    );
    expect(v.summary).not.toContain('\n| FORGED-1');
    const tableLines = v.summary.split('\n').filter((l) => l.startsWith('|'));
    // header + separator + exactly one data row
    expect(tableLines).toHaveLength(3);
  });

  it('escapes backticks, asterisks and underscores in status names', () => {
    const v = buildVerdictFromOutcomes([found('PRJ-1', '`code` *bold* _it_')], cfg, {
      commitCount: 1,
    });
    expect(v.summary).toContain('\\`code\\` \\*bold\\* \\_it\\_');
  });

  it('escapes hostile issue keys in the link text and percent-encodes the browse URL', () => {
    // Reachable only via a permissive custom JIRA_KEY_REGEX — must still be inert.
    const v = buildVerdictFromOutcomes(
      [{ key: 'EVIL-1](https://evil.example/x)', outcome: 'not_found' }],
      cfg,
      { commitCount: 1 },
    );
    expect(v.summary).toContain(
      '[EVIL-1\\]\\(https://evil.example/x\\)](https://jira.example.com/browse/EVIL-1%5D%28https%3A%2F%2Fevil.example%2Fx%29)',
    );
    expect(v.summary).not.toContain('](https://evil.example');
  });

  it('percent-encodes characters encodeURIComponent leaves raw', () => {
    const v = buildVerdictFromOutcomes([{ key: "K-1()!'*", outcome: 'not_found' }], cfg, {
      commitCount: 1,
    });
    expect(v.summary).toContain('/browse/K-1%28%29%21%27%2A)');
  });

  it('leaves ordinary keys and statuses untouched', () => {
    const v = buildVerdictFromOutcomes([found('PRJ-7', 'In Progress')], cfg, { commitCount: 1 });
    expect(v.summary).toContain('[PRJ-7](https://jira.example.com/browse/PRJ-7)');
    expect(v.summary).toContain('| In Progress |');
  });
});

describe('homepage footer link (PUBLIC_URL)', () => {
  const publicCfg = loadConfig(testEnv({ PUBLIC_URL: 'https://merge-lock.example.com' }));
  const LINK = '[What is this check?](https://merge-lock.example.com/)';

  it('appends the link to table summaries when PUBLIC_URL is set', () => {
    const v = buildVerdictFromOutcomes([found('PRJ-1', 'Closed')], publicCfg, { commitCount: 1 });
    expect(v.summary.endsWith(LINK)).toBe(true);
  });

  it('omits the link when PUBLIC_URL is unset', () => {
    const v = buildVerdictFromOutcomes([found('PRJ-1', 'Closed')], cfg, { commitCount: 1 });
    expect(v.summary).not.toContain('What is this check?');
  });

  it('appends the link to zero-key summaries (both modes)', () => {
    expect(buildVerdictFromOutcomes([], publicCfg, { commitCount: 1 }).summary).toContain(LINK);
    const strict = loadConfig(
      testEnv({ PUBLIC_URL: 'https://merge-lock.example.com', REQUIRE_ISSUE_KEY: 'true' }),
    );
    expect(buildVerdictFromOutcomes([], strict, { commitCount: 1 }).summary).toContain(LINK);
    expect(buildVerdictFromOutcomes([], cfg, { commitCount: 1 }).summary).not.toContain(
      'What is this check?',
    );
  });

  it('appends the link to both error verdicts', () => {
    expect(buildErrorVerdict('jira_unreachable', publicCfg).summary).toContain(LINK);
    expect(buildErrorVerdict('too_many_commits', publicCfg, { totalCommits: 9 }).summary).toContain(
      LINK,
    );
    expect(buildErrorVerdict('jira_unreachable', cfg).summary).not.toContain('What is this check?');
  });

  it('survives summary truncation (footer is reserved space)', () => {
    const outcomes = Array.from({ length: 2000 }, (_, i) => found(`TRUNC-${i}`, 'In Review'));
    const v = buildVerdictFromOutcomes(outcomes, publicCfg, { commitCount: 2000 });
    expect(v.summary.length).toBeLessThanOrEqual(60_000);
    expect(v.summary).toMatch(/…and \d+ more issues/);
    expect(v.summary.endsWith(LINK)).toBe(true);
  });

  it('does not enter the fingerprint — same outcomes with and without PUBLIC_URL match', () => {
    const outcomes = [found('PRJ-1', 'In Progress'), found('PRJ-2', 'Closed')];
    expect(buildVerdictFromOutcomes(outcomes, publicCfg, { commitCount: 1 }).fingerprint).toBe(
      buildVerdictFromOutcomes(outcomes, cfg, { commitCount: 1 }).fingerprint,
    );
    expect(buildVerdictFromOutcomes([], publicCfg, { commitCount: 1 }).fingerprint).toBe(
      buildVerdictFromOutcomes([], cfg, { commitCount: 1 }).fingerprint,
    );
    expect(buildErrorVerdict('jira_unreachable', publicCfg).fingerprint).toBe(
      buildErrorVerdict('jira_unreachable', cfg).fingerprint,
    );
    expect(buildErrorVerdict('too_many_commits', publicCfg).fingerprint).toBe(
      buildErrorVerdict('too_many_commits', cfg).fingerprint,
    );
  });
});

describe('fingerprint', () => {
  const outcomes: JiraIssueOutcome[] = [
    found('PRJ-1', 'Closed'),
    found('PRJ-2', 'In Progress'),
    { key: 'UTF-8', outcome: 'not_found' },
  ];

  it('is a sha256 hex digest', () => {
    const v = buildVerdictFromOutcomes(outcomes, cfg, { commitCount: 1 });
    expect(v.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across calls and outcome ordering', () => {
    const a = buildVerdictFromOutcomes(outcomes, cfg, { commitCount: 1 });
    const b = buildVerdictFromOutcomes([...outcomes].reverse(), cfg, { commitCount: 5 });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('changes when a status changes', () => {
    const a = buildVerdictFromOutcomes(outcomes, cfg, { commitCount: 1 });
    const b = buildVerdictFromOutcomes(
      [found('PRJ-1', 'Closed'), found('PRJ-2', 'Closed'), { key: 'UTF-8', outcome: 'not_found' }],
      cfg,
      { commitCount: 1 },
    );
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('changes when the config hash differs', () => {
    const otherCfg = loadConfig(testEnv({ CHECK_NAME: 'other-check' }));
    expect(otherCfg.configHash).not.toBe(cfg.configHash);
    const a = buildVerdictFromOutcomes(outcomes, cfg, { commitCount: 1 });
    const b = buildVerdictFromOutcomes(outcomes, otherCfg, { commitCount: 1 });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe('buildErrorVerdict', () => {
  it('jira_unreachable fails with the outage policy explained', () => {
    const v = buildErrorVerdict('jira_unreachable', cfg);
    expect(v.conclusion).toBe('failure');
    expect(v.title).toBe('Jira unreachable — cannot verify referenced issues');
    expect(v.summary).toContain('keep');
    expect(v.summary.toLowerCase()).toContain('heals itself');
    expect(v.issues).toEqual([]);
    expect(v.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('too_many_commits fails mentioning the count and advising a split', () => {
    const v = buildErrorVerdict('too_many_commits', cfg, { totalCommits: 612 });
    expect(v.conclusion).toBe('failure');
    expect(v.title).toContain('612');
    expect(v.title.toLowerCase()).toContain('split');
    expect(v.summary).toContain('612');
    expect(v.issues).toEqual([]);
  });

  it('too_many_commits works without a commit count', () => {
    const v = buildErrorVerdict('too_many_commits', cfg);
    expect(v.conclusion).toBe('failure');
    expect(v.title.toLowerCase()).toContain('split');
  });

  it('error fingerprints are stable per kind and distinct across kinds', () => {
    const a1 = buildErrorVerdict('jira_unreachable', cfg);
    const a2 = buildErrorVerdict('jira_unreachable', cfg);
    const b = buildErrorVerdict('too_many_commits', cfg);
    expect(a1.fingerprint).toBe(a2.fingerprint);
    expect(a1.fingerprint).not.toBe(b.fingerprint);
  });

  it('error fingerprints fold in the config hash', () => {
    const otherCfg = loadConfig(testEnv({ CHECK_NAME: 'other-check' }));
    const a = buildErrorVerdict('jira_unreachable', cfg);
    const b = buildErrorVerdict('jira_unreachable', otherCfg);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});
