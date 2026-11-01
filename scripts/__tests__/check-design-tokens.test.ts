import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  COVERAGE,
  OVERRIDE_LABEL,
  RULES,
  RULE_HELPERS,
  SCRIPT_PATH,
  compare,
  countIn,
  lowered,
  raisedAgainst,
  seedableRules,
  type Rule,
} from '../check-design-tokens.ts';
import {
  fingerprint,
  overrideCovers,
  ruleChanges,
  type Gate,
  type OverrideApi,
  type OverrideEvent,
  type RuleSet,
} from '../design-tokens/rule-guard.ts';

const UI = 'packages/ui/src/thing.tsx';
const CLIENT = 'apps/client/src/thing.tsx';

describe('countIn', () => {
  it('finds each pattern', () => {
    expect(countIn(CLIENT, `'bg-black/80 text-white focus-visible:ring-2 bg-red-500'`)).toEqual({
      'black-scrim': 1,
      'raw-palette': 1,
      'pure-white-black': 1,
      'stray-focus-ring': 1,
    });
  });

  it('counts a literal z-index only in the package', () => {
    expect(countIn(UI, `'z-50 z-[60]'`)).toEqual({ 'literal-z-index': 2 });
    expect(countIn(CLIENT, `'z-50'`)).toEqual({});
  });

  it('leaves the tokens and look-alikes alone', () => {
    const clean = `'bg-scrim z-(--z-overlay) text-white-ish md:z-5 bg-brand/15 #fffae0'`;
    expect(countIn(UI, clean)).toEqual({});
  });

  it('counts the pure hexes in both lengths', () => {
    expect(countIn(CLIENT, `'#fff #000000 #FFF'`)).toEqual({ 'pure-white-black': 3 });
  });
});

describe('the count and badge rules (Phase 2 Badge A)', () => {
  const PILL = 'packages/ui/src/count-pill.tsx';
  // The app's re-export holds no pill of its own, so it is not on the allowlist.
  const OLD_PILL = 'apps/client/src/layers/shared/ui/count-pill.tsx';
  const THREAD = 'apps/client/src/layers/features/conversation/ui/rows/ThreadReplyRow.tsx';

  it('refuses a local cap, except where the caps are spelled', () => {
    expect(countIn(CLIENT, `const DISPLAY_CAP = 9; const MAX_COUNT = 99;`)).toEqual({
      'local-count-cap': 2,
    });
    expect(countIn(PILL, `export const COUNT_PILL_CAP = 99;`)).toEqual({});
    expect(countIn(OLD_PILL, `export const COUNT_PILL_CAP = 99;`)).toEqual({
      'local-count-cap': 1,
    });
    expect(countIn(CLIENT, `import { COUNT_PILL_CAP } from '@/layers/shared/ui';`)).toEqual({});
  });

  it('refuses a hand-rolled count on one line, in either order', () => {
    const text = `'rounded-full px-1.5 tabular-nums'\n'tabular-nums text-xs rounded-full'\n'tabular-nums'`;
    expect(countIn(CLIENT, text)).toEqual({ 'hand-rolled-count': 2 });
    expect(countIn(PILL, text)).toEqual({});
    expect(countIn(OLD_PILL, text)).toEqual({ 'hand-rolled-count': 2 });
  });

  it('keeps the count flip to the thread reply row', () => {
    expect(countIn(CLIENT, `'motion-safe:animate-count-flip'`)).toEqual({ 'count-flip': 1 });
    expect(countIn(THREAD, `'motion-safe:animate-count-flip'`)).toEqual({});
  });
});

describe('the card and row rules', () => {
  const SHARED = 'apps/client/src/layers/shared/ui/thing.tsx';

  it('fails a divide-y in shared/ui, except the table', () => {
    expect(countIn(SHARED, `'divide-border divide-y'`)).toEqual({ 'shared-divide-y': 1 });
    expect(countIn('apps/client/src/layers/shared/ui/table.tsx', `'divide-y'`)).toEqual({});
    expect(countIn(CLIENT, `'divide-y'`)).toEqual({});
  });

  it('fails a border on a FieldCard', () => {
    expect(countIn(CLIENT, `<FieldCard className="border-destructive/50">`)).toEqual({
      'field-card-border': 1,
    });
    expect(countIn(CLIENT, `<FieldCard className="mt-6">`)).toEqual({});
  });

  it('fails a border on the card and group primitives only', () => {
    const card = 'apps/client/src/layers/shared/ui/card.tsx';
    expect(countIn(card, `'bg-card shadow-soft flex border p-4'`)).toEqual({ 'card-border': 1 });
    expect(countIn(card, `'bg-card shadow-soft flex p-4'`)).toEqual({});
    expect(countIn(CLIENT, `'bg-card border'`)).toEqual({});
  });

  it('fails a ring-2 as a row mark, outside the topology canvas', () => {
    expect(countIn(CLIENT, `isFocused && 'ring-ring ring-2'`)).toEqual({ 'row-ring-mark': 1 });
    expect(
      countIn('apps/client/src/layers/features/mesh/ui/AgentNode.tsx', `selected && 'ring-2'`)
    ).toEqual({});
  });
});

describe('the room row rules (Phase 4 rooms A)', () => {
  const NOTICE = 'apps/client/src/layers/features/conversation/ui/rows/NoticeRow.tsx';
  const PILLS = 'apps/client/src/layers/features/entry-actions/ui/EntryReactionRow.tsx';

  it('refuses amber words in a room row, but never the glyph token', () => {
    expect(countIn(NOTICE, `'text-status-warning'`)).toEqual({ 'room-warning-text': 1 });
    expect(countIn(NOTICE, `'text-status-warning-fg'`)).toEqual({});
    expect(countIn(CLIENT, `'text-status-warning'`)).toEqual({});
  });

  it('refuses the reaction ring anywhere', () => {
    expect(countIn(CLIENT, `'motion-safe:animate-reaction-ring'`)).toEqual({ 'reaction-ring': 1 });
  });

  it('refuses italic in a room row class, not in prose about it', () => {
    expect(countIn(NOTICE, `className="text-xs italic"`)).toEqual({ 'room-italic': 1 });
    expect(countIn(NOTICE, ` * one italic muted line, with \`body.notice\``)).toEqual({});
    expect(countIn(CLIENT, `className="italic"`)).toEqual({});
  });

  it('refuses a border on a reaction pill, not the word in a comment', () => {
    expect(countIn(PILLS, `'rounded-full border px-2'`)).toEqual({ 'reaction-pill-border': 1 });
    expect(countIn(PILLS, `'border-brand/70 bg-brand/12'`)).toEqual({ 'reaction-pill-border': 1 });
    expect(countIn(PILLS, `// No border on either kind`)).toEqual({});
    expect(countIn(PILLS, `'bg-foreground/5 dui-dark:border'`)).toEqual({});
  });
});

describe('the motion rules', () => {
  const MOTION = 'apps/client/src/layers/shared/lib/motion.ts';
  const CSS = 'apps/client/src/index.css';

  it('counts a spring literal, but never in the motion module', () => {
    const text = "{ type: 'spring', stiffness: 400 } // { stiffness: 1 }";
    expect(countIn(CLIENT, text)).toEqual({ 'spring-literal': 2 });
    expect(countIn(MOTION, text)).toEqual({});
  });

  it.each([
    ['a y above 1', 'animation: x 1s cubic-bezier(0.2, 1.4, 0.4, 1);', 1],
    ['a y below 0', 'animation: x 1s cubic-bezier(0.2, -0.4, 0.4, 1);', 1],
    ['a curve that stays in range', 'animation: x 1s cubic-bezier(0.4, 0, 0.2, 1);', 0],
    ['the reaction pop', 'animation: reaction-pop 1s cubic-bezier(0.2, 1.8, 0.35, 1);', 0],
    [
      'the reaction pop as index.css spells it',
      '  animation: reaction-pop var(--msg-reaction-pop) cubic-bezier(0.2, 1.8, 0.35, 1);',
      0,
    ],
    [
      'a selector on the reaction pop line',
      '.x { animation: reaction-pop 1s cubic-bezier(0.2, 1.8, 0.35, 1); } .y { transition: transform 1s cubic-bezier(0.2, 1.4, 0.4, 1); }',
      2,
    ],
    [
      'a custom property named for the reaction pop',
      '--reaction-pop-ease: cubic-bezier(0.2, 1.8, 0.35, 1);',
      1,
    ],
    [
      'a second animation beside the reaction pop',
      'animation: reaction-pop 1s cubic-bezier(0.2, 1.8, 0.35, 1), x 1s cubic-bezier(0.2, 1.4, 0.4, 1);',
      2,
    ],
    ['a comment', '/* cubic-bezier(0.2, 1.4, 0.4, 1) */', 0],
  ])('overshoot rule on %s', (_name, text, expected) => {
    expect(countIn(CSS, text)['overshoot-bezier'] ?? 0).toBe(expected);
  });

  it('lists every helper a count calls, so a loosened helper is a rule change', () => {
    for (const rule of RULES.filter((r) => r.count)) {
      const source = String(rule.count);
      const named = [
        ...source.matchAll(/(?<![.\w])([A-Za-z_]\w*)\s*\(/g),
        ...source.matchAll(/(?<![.\w])([A-Z][A-Z0-9_]+)\b/g),
      ].map((m) => m[1] as string);
      expect(named.filter((n) => !(n in RULE_HELPERS))).toEqual([]);
    }
  });

  it('reads the overshoot rule only in index.css, and no colour rule reads CSS', () => {
    expect(countIn('apps/client/src/other.css', 'x: cubic-bezier(0.2, 1.4, 0.4, 1)')).toEqual({});
    expect(countIn(CSS, 'color: #fff; bg-black/50')).toEqual({});
  });
});

describe('compare', () => {
  it('fails a hard rule even when the baseline names it', () => {
    const counts = { 'black-scrim': { [CLIENT]: 1 } };
    expect(compare(counts, counts).map((f) => f.kind)).toEqual(['hard']);
  });

  it('holds a ratchet level, fails a rise, and asks for an update on a fall', () => {
    const baseline = { 'raw-palette': { [CLIENT]: 2 } };
    expect(compare({ 'raw-palette': { [CLIENT]: 2 } }, baseline)).toEqual([]);
    expect(compare({ 'raw-palette': { [CLIENT]: 3 } }, baseline)[0]?.kind).toBe('grew');
    expect(compare({ 'raw-palette': { [CLIENT]: 1 } }, baseline)[0]?.kind).toBe('stale');
    expect(compare({}, baseline)[0]?.kind).toBe('stale');
  });

  it('starts a new file at zero', () => {
    expect(compare({ 'raw-palette': { [UI]: 1 } }, {})[0]).toMatchObject({
      kind: 'grew',
      baseline: 0,
    });
  });
});

describe('the baseline only goes down', () => {
  it('refuses a raised or added entry', () => {
    const base = { 'raw-palette': { [CLIENT]: 2 } };
    expect(raisedAgainst({ 'raw-palette': { [CLIENT]: 2 } }, base)).toEqual([]);
    expect(raisedAgainst({ 'raw-palette': { [CLIENT]: 3 } }, base)[0]?.kind).toBe('raised');
    expect(raisedAgainst({ 'raw-palette': { [UI]: 1 } }, base)[0]?.kind).toBe('raised');
  });

  describe('seeding a new rule', () => {
    const NEW = 'spring-literal';
    const ratchet = (id: string): Rule => ({ id, kind: 'ratchet', pattern: /x/g, fix: '' });
    const base = { 'raw-palette': { [CLIENT]: 2 } };
    const baseIds = ['raw-palette', 'stray-focus-ring'];
    const withNew = [ratchet('raw-palette'), ratchet('stray-focus-ring'), ratchet(NEW)];
    const seedable = seedableRules(withNew, baseIds);
    const measured = { [NEW]: { [CLIENT]: 3, [UI]: 1 } };

    it('lets a rule the base never defined start at what the check measures', () => {
      expect(seedable).toEqual(new Set([NEW]));
      const seed = { ...base, [NEW]: { [CLIENT]: 3, [UI]: 1 } };
      expect(raisedAgainst(seed, base, seedable, measured)).toEqual([]);
    });

    it('refuses a seed above the measured count', () => {
      const seed = { ...base, [NEW]: { [CLIENT]: 4, [UI]: 1 } };
      const found = raisedAgainst(seed, base, seedable, measured);
      expect(found.map((f) => [f.kind, f.file, f.baseline])).toEqual([['raised', CLIENT, 3]]);
    });

    it('refuses a rename that would reseed the old rule under a new name', () => {
      const renamed = [ratchet('palette-colour'), ratchet('stray-focus-ring')];
      expect(seedableRules(renamed, baseIds)).toEqual(new Set());
      const seed = { 'palette-colour': { [CLIENT]: 2 } };
      const counts = { 'palette-colour': { [CLIENT]: 2 } };
      expect(raisedAgainst(seed, base, seedableRules(renamed, baseIds), counts)).toHaveLength(1);
    });

    it('refuses a rule that was removed, even when another one is new', () => {
      expect(seedableRules([ratchet('raw-palette'), ratchet(NEW)], baseIds)).toEqual(new Set());
    });

    it('refuses a seed for a rule the base already defines', () => {
      const defined = seedableRules(withNew, [...baseIds, NEW]);
      expect(defined).toEqual(new Set());
      const seed = { ...base, [NEW]: { [CLIENT]: 3 } };
      expect(raisedAgainst(seed, base, defined, measured)).toHaveLength(1);
    });

    it('seeds nothing when the base rule list is unknown, and never seeds a hard rule', () => {
      expect(seedableRules(withNew, null)).toEqual(new Set());
      const hard: Rule = { ...ratchet('black-scrim'), kind: 'hard' };
      expect(seedableRules([...withNew, hard], baseIds)).toEqual(new Set([NEW]));
    });
  });

  it('update lowers and removes, and never raises or adds', () => {
    const baseline = { 'raw-palette': { [CLIENT]: 2, [UI]: 4 } };
    expect(lowered({ 'raw-palette': { [CLIENT]: 9 } }, baseline)).toEqual({
      'raw-palette': { [CLIENT]: 2 },
    });
    expect(lowered({ 'stray-focus-ring': { [CLIENT]: 1 } }, baseline)).toEqual({});
  });
});

describe('RULES', () => {
  it('every pattern is global, or countIn would stop at the first match', () => {
    expect(RULES.filter((r) => !r.pattern.global)).toEqual([]);
  });

  it('the gate imports nothing relative at the top, so a base copy loads alone', () => {
    const text = readFileSync(new URL('../check-design-tokens.ts', import.meta.url), 'utf8');
    expect(text.match(/^import [^;]* from '\.[^']*';/gm)).toBeNull();
  });
});

describe('a base rule may not be removed or changed (DOR-3557)', () => {
  const HEAD: RuleSet = { rules: RULES, helpers: RULE_HELPERS, coverage: COVERAGE };
  const replaced = (id: string, change: Partial<Rule>): Rule[] =>
    RULES.map((r) => (r.id === id ? { ...r, ...change } : r));

  it('passes unchanged rules, a reworded fix and an added rule', () => {
    expect(ruleChanges(HEAD, HEAD)).toEqual([]);
    const reworded = replaced('black-scrim', { fix: 'say it another way' });
    const added: Rule = { id: 'new-one', kind: 'ratchet', pattern: /x/g, fix: '' };
    expect(ruleChanges(HEAD, { ...HEAD, rules: [...reworded, added] })).toEqual([]);
  });

  it('refuses a removed rule', () => {
    const head = { ...HEAD, rules: RULES.filter((r) => r.id !== 'raw-palette') };
    expect(ruleChanges(HEAD, head)).toEqual(['rule raw-palette was removed']);
  });

  it('refuses a loosened pattern', () => {
    const head = { ...HEAD, rules: replaced('black-scrim', { pattern: /\bbg-black\/9\d/g }) };
    expect(ruleChanges(HEAD, head)).toEqual(['rule black-scrim changed']);
  });

  it('refuses a widened except', () => {
    const head = { ...HEAD, rules: replaced('count-flip', { except: /ThreadReplyRow|Thread/ }) };
    expect(ruleChanges(HEAD, head)).toEqual(['rule count-flip changed']);
  });

  it.each([
    ['kind', { kind: 'ratchet' as const }],
    ['only', { only: /^apps\/client\/src\/layers\/shared\/ui\/card\.tsx$/ }],
    ['files', { files: /\.tsx$/ }],
    ['flags', { pattern: /\bbg-black\/\d+/ }],
  ])('refuses a changed %s', (_field, change) => {
    const id = _field === 'only' ? 'card-border' : 'black-scrim';
    expect(ruleChanges(HEAD, { ...HEAD, rules: replaced(id, change) })).toEqual([
      `rule ${id} changed`,
    ]);
  });

  it('refuses a changed count, a changed helper, and a base with no helpers to compare', () => {
    const counted = replaced('overshoot-bezier', { count: () => 0 });
    expect(ruleChanges(HEAD, { ...HEAD, rules: counted })).toEqual([
      'rule overshoot-bezier changed',
    ]);
    const helpers = { ...RULE_HELPERS, overshoots: () => false };
    expect(ruleChanges(HEAD, { ...HEAD, helpers })).toEqual(['rule overshoot-bezier changed']);
    expect(ruleChanges({ ...HEAD, helpers: undefined }, HEAD)).toEqual([
      'rule overshoot-bezier changed',
    ]);
  });

  it('refuses a narrowed coverage, and a base with none to compare', () => {
    const coverage = { ...COVERAGE, scopes: ['apps/client/src'] };
    expect(ruleChanges(HEAD, { ...HEAD, coverage })).toEqual([
      'what every rule reads (COVERAGE) changed',
    ]);
    expect(ruleChanges({ ...HEAD, coverage: undefined }, HEAD)).toEqual([
      'what every rule reads (COVERAGE) changed',
    ]);
  });

  it('treats a rule as itself whatever order the fields are in', () => {
    const rule = RULES[0] as Rule;
    const reordered = Object.fromEntries(Object.entries(rule).reverse()) as unknown as Rule;
    expect(fingerprint(reordered, RULE_HELPERS)).toBe(fingerprint(rule, RULE_HELPERS));
  });
});

describe('the guard-rule-change label', () => {
  const SHA = 'head1';
  const REF = 'feat/rule';
  const EARLY = '2026-11-01T10:00:00Z';
  const LATE = '2026-11-01T11:00:00Z';
  const LATER = '2026-11-01T12:00:00Z';
  const prEvent: OverrideEvent = {
    name: 'pull_request',
    payload: { pull_request: { number: 7, head: { sha: SHA } } },
  };
  const group = { base_ref: 'refs/heads/main', base_sha: 'base', head_sha: 'group1' };
  const groupEvent: OverrideEvent = { name: 'merge_group', payload: { merge_group: group } };
  const entry = {
    baseCommit: { oid: 'base' },
    headCommit: { oid: 'group1' },
    pullRequest: { number: 7, headRefOid: SHA },
  };

  let gate: Gate;
  beforeAll(async () => {
    // Specifiers in variables: these are untyped .mjs, read through `Gate`.
    const gatePath = new URL('../../.github/scripts/security-gate.mjs', import.meta.url).href;
    const labelPath = new URL('../../.github/scripts/security-label-at-head.mjs', import.meta.url)
      .href;
    const g = (await import(gatePath)) as Gate;
    const l = (await import(labelPath)) as Gate;
    gate = {
      labelNewerThanHead: l.labelNewerThanHead,
      firstCheckSuite: l.firstCheckSuite,
      groupMembers: g.groupMembers,
      queuedSensitiveDiff: g.queuedSensitiveDiff,
    };
  });

  function api({
    labels = [OVERRIDE_LABEL],
    labelledAt = LATE,
    actor = 'User',
    pushedAt = EARLY,
    committedAt = EARLY,
    suites = [EARLY],
    files = [SCRIPT_PATH],
    queue = async (): Promise<object[]> => [entry],
  } = {}): OverrideApi {
    return {
      pr: async () => ({ head: { sha: SHA, ref: REF }, labels: labels.map((name) => ({ name })) }),
      timeline: async () => [
        {
          event: 'labeled',
          label: { name: OVERRIDE_LABEL },
          created_at: labelledAt,
          actor: { type: actor },
        },
      ],
      activity: async () => [{ after: SHA, ref: `refs/heads/${REF}`, timestamp: pushedAt }],
      commit: async () => ({ commit: { committer: { date: committedAt } } }),
      checkSuites: async () => suites.map((created_at) => ({ created_at })),
      queue,
      compare: async () => ({
        base_commit: { sha: 'base' },
        merge_base_commit: { sha: 'base' },
        files: files.map((filename) => ({ filename })),
      }),
    };
  }

  it('accepts a label a person added after the head', async () => {
    expect(await overrideCovers(api(), gate, prEvent)).toMatchObject({ passed: true });
  });

  it('refuses a label older than the head', async () => {
    const verdict = await overrideCovers(api({ pushedAt: LATER }), gate, prEvent);
    expect(verdict).toMatchObject({ passed: false });
    expect(verdict.reason).toContain('older than the last push');
  });

  it.each([
    ['a committer date', { committedAt: LATER }],
    ['a first check suite', { suites: [LATER, '2026-11-01T13:00:00Z'] }],
  ])('refuses a label older than %s', async (_name, input) => {
    expect(await overrideCovers(api(input), gate, prEvent)).toMatchObject({ passed: false });
  });

  it.each([
    ['no label', { labels: [] }],
    ['a label a bot added', { actor: 'Bot' }],
    ['no check suite, so no push time', { suites: [] }],
  ])('refuses %s', async (_name, input) => {
    expect(await overrideCovers(api(input), gate, prEvent)).toMatchObject({ passed: false });
  });

  it('refuses with no token, and on an event with no PR', async () => {
    expect(await overrideCovers(null, null, prEvent)).toMatchObject({ passed: false });
    const canary: OverrideEvent = { name: 'schedule', payload: {} };
    expect(await overrideCovers(api(), gate, canary)).toMatchObject({ passed: false });
  });

  it('reads each PR in a merge group, and accepts a fresh label on the one that changed the rule', async () => {
    expect(await overrideCovers(api(), gate, groupEvent)).toMatchObject({ passed: true });
  });

  it('refuses a merge group when the queue lookup fails', async () => {
    const queue = async (): Promise<object[]> => {
      throw new Error('GitHub API 502 at /graphql');
    };
    const verdict = await overrideCovers(api({ queue }), gate, groupEvent);
    expect(verdict).toMatchObject({ passed: false });
    expect(verdict.reason).toContain('502');
  });

  it('refuses a merge group whose PR has a stale label, or where no PR touched the gate', async () => {
    expect(await overrideCovers(api({ pushedAt: LATER }), gate, groupEvent)).toMatchObject({
      passed: false,
    });
    expect(await overrideCovers(api({ files: ['README.md'] }), gate, groupEvent)).toMatchObject({
      passed: false,
    });
  });
});
