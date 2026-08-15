/**
 * Fixture matrix for the DOR-1222 append-only rule (`migration-append-only.ts`).
 *
 * The real repository can only ever be in one state at a time — today, "nothing
 * has drifted" — so the cases worth having are the ones that must FAIL, and they
 * are built here out of hand-written source text. `config-manager.test.ts` runs
 * the same rule over the real file and the real pins.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

import {
  checkAppendOnly,
  extractTopLevelFunctions,
  migrationClosure,
  migrationHash,
  normalizeForHash,
} from './migration-append-only.js';

/** A helper shaped exactly like the real ones: inline object param, `}): void {`. */
function helper(name: string, body: string, doc = 'documented'): string {
  return [
    '/**',
    ` * ${doc}`,
    ' */',
    `export function ${name}(store: {`,
    '  get: (key: string) => unknown;',
    '  set: (key: string, value: unknown) => void;',
    '}): void {',
    `  ${body}`,
    '}',
  ].join('\n');
}

/** Build a `config-manager.ts`-shaped file from table entries and declarations. */
function sourceWith(entries: string[], declarations: string[] = []): string {
  return [
    'export const CONFIG_MIGRATIONS = {',
    ...entries,
    '} as const;',
    '',
    ...declarations,
  ].join('\n');
}

const SEED = helper('backfillSeed', "store.set('seed', true);");
const OTHER = helper('backfillOther', "store.set('other', 1);");

const SOURCE = sourceWith(
  ["  '0.59.0': backfillSeed,", "  '0.60.0': backfillOther,"],
  [SEED, OTHER]
);

const PINS = {
  '0.59.0': migrationHash('0.59.0', SOURCE),
  '0.60.0': migrationHash('0.60.0', SOURCE),
};

describe('extractTopLevelFunctions', () => {
  it('captures the whole declaration, not just the parameter list', () => {
    // The regression this rule was first written with: every helper here takes
    // an inline object type that Prettier closes with `}): void {` at column
    // zero, so a terminator search that accepts a leading `}` stops there and
    // pins a signature while the body drifts freely underneath.
    const fns = extractTopLevelFunctions(SEED);
    expect(fns['backfillSeed']).toContain("store.set('seed', true);");
  });

  it('ignores a function keyword that is only prose or a string', () => {
    const source = [
      '// export function notReal(a: string) {',
      "const s = 'export function alsoNotReal(a: string) {';",
      SEED,
    ].join('\n');
    expect(Object.keys(extractTopLevelFunctions(source))).toEqual(['backfillSeed']);
  });

  it('raises rather than truncating when a declaration never closes', () => {
    expect(() =>
      extractTopLevelFunctions('export function open(a: string) {\n  return a;')
    ).toThrow(/no closing line of its own/);
  });
});

describe('normalizeForHash', () => {
  it('ignores a comment change', () => {
    const before = helper('backfillSeed', "store.set('seed', true);", 'first wording');
    const after = helper('backfillSeed', "store.set('seed', true);", 'second wording');
    expect(normalizeForHash(after)).toBe(normalizeForHash(before));
  });

  it('ignores Prettier reflow — line breaks, indentation, trailing commas', () => {
    const flat = 'call(alpha, beta);';
    const broken = 'call(\n      alpha,\n      beta,\n    );';
    expect(normalizeForHash(broken)).toBe(normalizeForHash(flat));
  });

  it('keeps the contents of a string, including something that looks like a comment', () => {
    expect(normalizeForHash("const s = '// not a comment';")).toContain('// not a comment');
  });

  it('sees a real change', () => {
    expect(normalizeForHash("store.set('seed', true);")).not.toBe(
      normalizeForHash("store.set('seed', false);")
    );
  });
});

describe('migrationClosure', () => {
  it('follows a bare helper reference into the helper it names', () => {
    // Half the real table is `'0.50.0': backfillSidebarDefaults` — a rule that
    // hashed the table slice alone would pin a function NAME and nothing else.
    expect(migrationClosure('0.59.0', SOURCE)).toContain("store.set('seed', true);");
  });

  it('follows a helper that calls another helper', () => {
    const inner = helper('backfillInner', "store.set('inner', 1);");
    const outer = helper('backfillOuter', 'backfillInner(store);');
    const source = sourceWith(["  '0.60.0': backfillOuter,"], [outer, inner]);
    expect(migrationClosure('0.60.0', source)).toContain("store.set('inner', 1);");
  });

  it('does not pull in a helper the key never reaches', () => {
    expect(migrationClosure('0.59.0', SOURCE)).not.toContain("store.set('other', 1);");
  });

  it('is unchanged by moving a declaration within the file', () => {
    const reordered = sourceWith(
      ["  '0.59.0': backfillSeed,", "  '0.60.0': backfillOther,"],
      [OTHER, SEED]
    );
    expect(migrationHash('0.59.0', reordered)).toBe(migrationHash('0.59.0', SOURCE));
  });

  it('raises for a key that is not in the table', () => {
    expect(() => migrationClosure('9.9.9', SOURCE)).toThrow(/not in CONFIG_MIGRATIONS/);
  });
});

describe('checkAppendOnly', () => {
  it('passes when every key matches its pin', () => {
    expect(checkAppendOnly(SOURCE, PINS)).toMatchObject({ ok: true, problems: [] });
  });

  it('passes a comment-only edit inside a merged body', () => {
    // Deliberate, and the one place this rule is looser than the byte-identity
    // rule next door: a stale sentence inside a body stays correctable. Prose is
    // not what upgrading installs ran.
    const reworded = sourceWith(
      ["  '0.59.0': backfillSeed,", "  '0.60.0': backfillOther,"],
      [helper('backfillSeed', "store.set('seed', true);", 'reworded'), OTHER]
    );
    expect(checkAppendOnly(reworded, PINS).ok).toBe(true);
  });

  it('fails when a merged body is edited in place', () => {
    const edited = sourceWith(
      ["  '0.59.0': backfillSeed,", "  '0.60.0': backfillOther,"],
      [helper('backfillSeed', "store.set('seed', false);"), OTHER]
    );

    const res = checkAppendOnly(edited, PINS);
    expect(res.ok).toBe(false);
    const said = res.problems.join('\n');
    expect(said).toMatch(/"0\.59\.0" changed after it was pinned/);
    expect(said).toMatch(/not tagged yet" is not evidence/);
    expect(said).toMatch(/open a NEW key/);
    // The escape hatch is named, so nobody has to guess whether one exists.
    expect(said).toMatch(/Repinning is the escape hatch/);
  });

  it('fails when only a HELPER the table calls is edited', () => {
    // The hole `contributing/configuration.md` recorded: the table slice is
    // untouched, so a rule that read only the table sees nothing. DOR-1121 was
    // exactly this edit.
    const edited = sourceWith(
      ["  '0.59.0': backfillSeed,", "  '0.60.0': backfillOther,"],
      [SEED, helper('backfillOther', "store.set('other', 2);")]
    );

    const res = checkAppendOnly(edited, PINS);
    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/"0\.60\.0" changed after it was pinned/);
  });

  it('fails an unpinned new key, and hands over the line to add', () => {
    const added = sourceWith(
      ["  '0.59.0': backfillSeed,", "  '0.60.0': backfillOther,", "  '0.61.0': backfillFresh,"],
      [SEED, OTHER, helper('backfillFresh', "store.set('fresh', 1);")]
    );

    const res = checkAppendOnly(added, PINS);
    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toContain(`'0.61.0': '${res.hashes['0.61.0']!}'`);
  });

  it('names the shared-helper case when several keys move at once', () => {
    // Editing one helper two keys reach moves both pins, and reads as two
    // unrelated violations unless the rule says otherwise. The legitimate
    // version of this — extend a fill-if-absent helper, add a new key that
    // re-runs it — is the one case where repinning is routine, so it is named
    // rather than left for the reader to reconstruct.
    const shared = helper('backfillShared', "store.set('shared', 1);");
    const before = sourceWith(
      ["  '0.59.0': backfillShared,", "  '0.60.0': backfillShared,"],
      [shared]
    );
    const pins = {
      '0.59.0': migrationHash('0.59.0', before),
      '0.60.0': migrationHash('0.60.0', before),
    };
    const after = sourceWith(
      ["  '0.59.0': backfillShared,", "  '0.60.0': backfillShared,"],
      [helper('backfillShared', "store.set('shared', 2);")]
    );

    const res = checkAppendOnly(after, pins);
    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/2 keys moved together \(0\.59\.0, 0\.60\.0\)/);
    expect(res.problems.join('\n')).toMatch(/backfillRoomsDefaults pattern/);
  });

  it('fails when a pinned key is removed from the table', () => {
    const dropped = sourceWith(["  '0.59.0': backfillSeed,"], [SEED, OTHER]);

    const res = checkAppendOnly(dropped, PINS);
    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/"0\.60\.0" is pinned but is no longer/);
  });
});
