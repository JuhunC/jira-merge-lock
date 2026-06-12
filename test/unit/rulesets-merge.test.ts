import { describe, expect, it } from 'vitest';
import { convergeRequiredChecks, stripReadOnlyRulesetFields } from '../../src/rulesets.js';
import type { OrgRuleset, RulesetRule } from '../../src/types.js';

const CHECK = 'jira-merge-lock';
const COMMENT_CHECK = 'jira-merge-lock-comments';
const APP_ID = 12345;

const ourEntry = { context: CHECK, integration_id: APP_ID };
const ourCommentEntry = { context: COMMENT_CHECK, integration_id: APP_ID };

/** The original single-context behavior is the [checkName]-only call. */
function injectRequiredCheck(
  rules: RulesetRule[] | undefined,
  checkName: string,
  appId: number,
): { rules: RulesetRule[]; changed: boolean } {
  return convergeRequiredChecks(rules, [checkName], appId);
}

function rscRule(
  entries: Array<{ context: string; integration_id?: number }>,
  extraParams: Record<string, unknown> = {},
): RulesetRule {
  return {
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: true,
      required_status_checks: entries,
      ...extraParams,
    },
  };
}

const otherRules: RulesetRule[] = [
  { type: 'pull_request', parameters: { required_approving_review_count: 2, dismiss_stale_reviews_on_push: true } },
  { type: 'non_fast_forward' },
];

describe('convergeRequiredChecks (single context)', () => {
  describe('table-driven', () => {
    const freshRsc: RulesetRule = {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: false,
        required_status_checks: [ourEntry],
      },
    };

    const cases: Array<{
      name: string;
      input: RulesetRule[] | undefined;
      expected: RulesetRule[];
      changed: boolean;
    }> = [
      {
        name: 'undefined rules -> appends a full rsc rule',
        input: undefined,
        expected: [freshRsc],
        changed: true,
      },
      {
        name: 'empty rules -> appends a full rsc rule',
        input: [],
        expected: [freshRsc],
        changed: true,
      },
      {
        name: 'no rsc rule among other rules -> appends, others untouched, order kept',
        input: [...otherRules],
        expected: [...otherRules, freshRsc],
        changed: true,
      },
      {
        name: 'rsc rule with other contexts -> our entry appended last',
        input: [rscRule([{ context: 'ci/build', integration_id: 999 }, { context: 'lint' }])],
        expected: [rscRule([{ context: 'ci/build', integration_id: 999 }, { context: 'lint' }, ourEntry])],
        changed: true,
      },
      {
        name: 'entry already pinned -> no change',
        input: [rscRule([{ context: 'ci/build', integration_id: 999 }, ourEntry])],
        expected: [rscRule([{ context: 'ci/build', integration_id: 999 }, ourEntry])],
        changed: false,
      },
      {
        name: 'wrong integration_id -> only that field changes',
        input: [rscRule([{ context: 'ci/build', integration_id: 999 }, { context: CHECK, integration_id: 777 }])],
        expected: [rscRule([{ context: 'ci/build', integration_id: 999 }, ourEntry])],
        changed: true,
      },
      {
        name: 'missing integration_id -> pinned',
        input: [rscRule([{ context: CHECK }])],
        expected: [rscRule([ourEntry])],
        changed: true,
      },
      {
        name: 'rsc rule without parameters -> entry list created',
        input: [{ type: 'required_status_checks' }],
        expected: [{ type: 'required_status_checks', parameters: { required_status_checks: [ourEntry] } }],
        changed: true,
      },
    ];

    it.each(cases)('$name', ({ input, expected, changed }) => {
      const result = injectRequiredCheck(input, CHECK, APP_ID);
      expect(result.rules).toEqual(expected);
      expect(result.changed).toBe(changed);
    });
  });

  it('never mutates its input', () => {
    const input = [
      ...structuredClone(otherRules),
      rscRule([{ context: CHECK, integration_id: 777 }], { custom_flag: 'keep-me' }),
    ];
    const snapshot = JSON.stringify(input);
    injectRequiredCheck(input, CHECK, APP_ID);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('leaves other entries, parameters, rules and ordering byte-identical', () => {
    const input = [
      otherRules[0]!,
      rscRule([{ context: 'ci/build', integration_id: 999 }, { context: 'lint' }], { unknown_param: { nested: 1 } }),
      otherRules[1]!,
    ];
    const { rules, changed } = injectRequiredCheck(input, CHECK, APP_ID);
    expect(changed).toBe(true);

    expect(JSON.stringify(rules[0])).toBe(JSON.stringify(input[0]));
    expect(JSON.stringify(rules[2])).toBe(JSON.stringify(input[2]));

    const params = rules[1]!.parameters!;
    expect(params.strict_required_status_checks_policy).toBe(true);
    expect(params.do_not_enforce_on_create).toBe(true);
    expect(params['unknown_param']).toEqual({ nested: 1 });
    const entries = params.required_status_checks!;
    expect(JSON.stringify(entries[0])).toBe(JSON.stringify({ context: 'ci/build', integration_id: 999 }));
    expect(JSON.stringify(entries[1])).toBe(JSON.stringify({ context: 'lint' }));
    expect(entries[2]).toEqual(ourEntry);
    expect(entries).toHaveLength(3);
  });

  it('wrong integration_id: everything except that one field is byte-identical', () => {
    const input = [rscRule([{ context: 'ci/build', integration_id: 999 }, { context: CHECK, integration_id: 777 }])];
    const { rules } = injectRequiredCheck(input, CHECK, APP_ID);
    const fixed = structuredClone(input);
    fixed[0]!.parameters!.required_status_checks![1]!.integration_id = APP_ID;
    expect(JSON.stringify(rules)).toBe(JSON.stringify(fixed));
  });

  it('is idempotent: f(f(x)) === f(x)', () => {
    const inputs: Array<RulesetRule[] | undefined> = [
      undefined,
      [],
      [...otherRules],
      [rscRule([{ context: 'ci/build', integration_id: 999 }])],
      [rscRule([{ context: CHECK, integration_id: 777 }])],
    ];
    for (const input of inputs) {
      const once = injectRequiredCheck(input, CHECK, APP_ID);
      const twice = injectRequiredCheck(once.rules, CHECK, APP_ID);
      expect(twice.changed).toBe(false);
      expect(JSON.stringify(twice.rules)).toBe(JSON.stringify(once.rules));
    }
  });
});

describe('convergeRequiredChecks (multiple contexts)', () => {
  it('injects both checks into an empty ruleset', () => {
    const { rules, changed } = convergeRequiredChecks([], [CHECK, COMMENT_CHECK], APP_ID);
    expect(changed).toBe(true);
    expect(rules[0]!.parameters!.required_status_checks).toEqual([ourEntry, ourCommentEntry]);
  });

  it('adds only the missing context, leaving foreign entries untouched', () => {
    const foreign = { context: 'ci/build', integration_id: 999 };
    const input = [rscRule([foreign, ourEntry])];
    const { rules, changed } = convergeRequiredChecks(input, [CHECK, COMMENT_CHECK], APP_ID);
    expect(changed).toBe(true);
    expect(rules[0]!.parameters!.required_status_checks).toEqual([
      foreign,
      ourEntry,
      ourCommentEntry,
    ]);
  });

  it('removes our own stale entry when its context is no longer desired (feature disabled)', () => {
    const foreign = { context: 'ci/build', integration_id: 999 };
    const input = [rscRule([foreign, ourEntry, ourCommentEntry])];
    const { rules, changed } = convergeRequiredChecks(input, [CHECK], APP_ID);
    expect(changed).toBe(true);
    expect(rules[0]!.parameters!.required_status_checks).toEqual([foreign, ourEntry]);
  });

  it('never removes same-named entries pinned to ANOTHER app, or unpinned ones', () => {
    const otherApps = [
      { context: COMMENT_CHECK, integration_id: 777 }, // another integration's check
      { context: 'manual-gate' }, // unpinned, admin-managed
    ];
    const input = [rscRule([...otherApps, ourEntry])];
    const { rules, changed } = convergeRequiredChecks(input, [CHECK], APP_ID);
    expect(changed).toBe(false);
    expect(rules[0]!.parameters!.required_status_checks).toEqual([...otherApps, ourEntry]);
  });

  it('is idempotent with two contexts', () => {
    const once = convergeRequiredChecks([...otherRules], [CHECK, COMMENT_CHECK], APP_ID);
    const twice = convergeRequiredChecks(once.rules, [CHECK, COMMENT_CHECK], APP_ID);
    expect(twice.changed).toBe(false);
    expect(JSON.stringify(twice.rules)).toBe(JSON.stringify(once.rules));
  });
});

describe('stripReadOnlyRulesetFields', () => {
  it('removes read-only fields and keeps everything else, including unknown fields', () => {
    const ruleset: OrgRuleset = {
      id: 42,
      node_id: 'RRS_abc',
      name: 'jira-merge-lock-main',
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [{ actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }],
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [{ type: 'non_fast_forward' }],
      _links: { self: { href: 'https://api.github.com/orgs/acme/rulesets/42' } },
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-06-01T00:00:00Z',
      source: 'acme',
      source_type: 'Organization',
      current_user_can_bypass: 'never',
      some_future_field: { keep: true },
    };
    const body = stripReadOnlyRulesetFields(ruleset);
    for (const gone of [
      'id',
      'node_id',
      '_links',
      'created_at',
      'updated_at',
      'source',
      'source_type',
      'current_user_can_bypass',
    ]) {
      expect(body).not.toHaveProperty(gone);
    }
    expect(body['name']).toBe('jira-merge-lock-main');
    expect(body['target']).toBe('branch');
    expect(body['enforcement']).toBe('active');
    expect(body['bypass_actors']).toEqual(ruleset['bypass_actors']);
    expect(body['conditions']).toEqual(ruleset.conditions);
    expect(body['rules']).toEqual(ruleset.rules);
    expect(body['some_future_field']).toEqual({ keep: true });
  });

  it('returns a copy — mutating the result does not touch the input', () => {
    const ruleset: OrgRuleset = { id: 1, name: 'jira-merge-lock-x', rules: [{ type: 'non_fast_forward' }] };
    const body = stripReadOnlyRulesetFields(ruleset);
    (body['rules'] as RulesetRule[]).push({ type: 'pull_request' });
    expect(ruleset.rules).toHaveLength(1);
  });
});
