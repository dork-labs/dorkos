/**
 * Fixture matrix for the DOR-1222 append-only rule (`migration-append-only.ts`).
 *
 * The real repository can only ever be in one state at a time — today, "nothing
 * has drifted" — so the cases worth having are the ones that must FAIL, and they
 * are built here out of hand-written source text. `config-manager.test.ts` runs
 * the same rule over the real file and the real pins.
 *
 * The source-reading half — `extractTopLevelDeclarations` and
 * `normalizeForHash` — now lives in `migration-closure.ts`, shared with the
 * tag-based rule (DOR-1135). Its matrix stays here, because the pins are what
 * those two exist to serve and a regression in either shows up as a moved hash.
 *
 * That walk crosses one import boundary, into `config-schema.ts` (DOR-1732), and
 * this rule is the only one that follows it. The boundary's own cases are in
 * their own block below; `migration-closure.ts` says why the tag rule stops
 * short of it.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

import { checkAppendOnly, migrationClosure, migrationHash } from './migration-append-only.js';
import {
  declarationPool,
  extractTopLevelDeclarations,
  normalizeForHash,
} from './migration-closure.js';
import type { ClosureSources } from './migration-closure.js';

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

/**
 * The two-file input the rule takes, defaulting the second half to empty.
 *
 * Most cases here are about `config-manager.ts` alone and say so by leaving the
 * schema out; the ones that exercise the import boundary (DOR-1732) pass both.
 *
 * @param configManager - A `config-manager.ts`-shaped source.
 * @param configSchema - A `config-schema.ts`-shaped source, when one matters.
 */
function sources(configManager: string, configSchema = ''): ClosureSources {
  return { configManager, configSchema };
}

const SEED = helper('backfillSeed', "store.set('seed', true);");
const OTHER = helper('backfillOther', "store.set('other', 1);");

const SOURCE = sourceWith(
  ["  '0.59.0': backfillSeed,", "  '0.60.0': backfillOther,"],
  [SEED, OTHER]
);

const PINS = {
  '0.59.0': migrationHash('0.59.0', sources(SOURCE)),
  '0.60.0': migrationHash('0.60.0', sources(SOURCE)),
};

describe('extractTopLevelDeclarations', () => {
  it('captures the whole declaration, not just the parameter list', () => {
    // The regression this rule was first written with: every helper here takes
    // an inline object type that Prettier closes with `}): void {` at column
    // zero, so a terminator search that accepts a leading `}` stops there and
    // pins a signature while the body drifts freely underneath.
    const fns = extractTopLevelDeclarations(SEED);
    expect(fns['backfillSeed']).toContain("store.set('seed', true);");
  });

  it('ignores a function keyword that is only prose or a string', () => {
    const source = [
      '// export function notReal(a: string) {',
      "const decoy = 'export function alsoNotReal(a: string) {';",
      SEED,
    ].join('\n');
    const names = Object.keys(extractTopLevelDeclarations(source));
    expect(names).toContain('backfillSeed');
    expect(names).toContain('decoy');
    expect(names).not.toContain('notReal');
    expect(names).not.toContain('alsoNotReal');
  });

  it('captures a binding whole, through the brackets inside it', () => {
    // `RETIRED_SIDEBAR_KEYS` is the real shape: an array with a spread call in
    // it, closed with `] as const;`. Stopping at the first `;` regardless of
    // depth would cut it, and stopping at the first `}` would cut the object
    // above it.
    const source = [
      'const RETIRED = [',
      '  ...Object.keys({ a: 1, b: 2 }),',
      "  'ungroupedSortMode',",
      '] as const;',
      '',
      SEED,
    ].join('\n');
    expect(extractTopLevelDeclarations(source)['RETIRED']).toContain('ungroupedSortMode');
    expect(extractTopLevelDeclarations(source)['RETIRED']).toMatch(/\] as const;$/);
  });

  it('never follows the migration table itself', () => {
    // A body that mentions CONFIG_MIGRATIONS must not drag the whole table into
    // its closure: every key's hash would then depend on every other key, and
    // adding one migration would break every pin at once.
    const source = sourceWith(
      ["  '0.59.0': backfillSeed,"],
      [helper('backfillSeed', 'void CONFIG_MIGRATIONS;'), OTHER]
    );
    expect(Object.keys(extractTopLevelDeclarations(source))).not.toContain('CONFIG_MIGRATIONS');
    expect(migrationClosure('0.59.0', sources(source))).not.toContain("store.set('other', 1);");
  });

  it('sees an async declaration and a generator', () => {
    // Neither form exists in config-manager.ts today, which is exactly why the
    // pattern has to know them: the cross-check compares this pattern against
    // itself on two inputs, so a form the pattern cannot express is invisible to
    // it, and a migration reaching such a helper would be pinned with a hole in
    // the middle and nothing to say so.
    const source = [
      'export async function backfillAsync(store: unknown): Promise<void> {',
      '  await Promise.resolve(store);',
      '}',
      '',
      'export function* walkThings(): Generator<number> {',
      '  yield 1;',
      '}',
    ].join('\n');
    const names = Object.keys(extractTopLevelDeclarations(source));
    expect(names).toContain('backfillAsync');
    expect(names).toContain('walkThings');
  });

  it('raises rather than losing declarations to a quote-bearing regex literal', () => {
    // The scanner's blind spot: the apostrophe in `/it's/` reads as a string
    // opening, so everything to the next quote is blanked — taking whole
    // declarations out of the guard's view. Without the cross-check the
    // extractor still fails here, but on a downstream symptom ("no closing line
    // of its own") that blames a well-formed declaration; the cross-check runs
    // first and names the scanner. The message is asserted, not just the throw.
    const source = [
      'export function stripApostrophes(text: string): string {',
      "  return text.replace(/it's/g, 'its');",
      '}',
      '',
      helper('backfillAfterTheRegex', "store.set('after', 1);"),
    ].join('\n');

    expect(() => extractTopLevelDeclarations(source)).toThrow(/top-level functions after masking/);
  });

  it('raises when the regex swallows a top-level BINDING and no function', () => {
    // The half the first cross-check missed. Here the regex-bearing function is
    // the last one in the file, so the FUNCTION counts agree and that check
    // passes — only the binding after it disappears.
    //
    // The assertion names bindings on purpose, and that is the whole test: with
    // the binding family removed from the cross-check this goes red, but it goes
    // red having thrown "function stripApostrophe has no closing line of its
    // own" — a real error, about the wrong declaration. Matching the message
    // rather than merely `toThrow()` is what separates "the guard names the
    // scanner" from "something, somewhere, blew up".
    const source = [
      'const BEFORE_THE_REGEX = 1;',
      'export function stripApostrophe(text: string): string {',
      "  return text.replace(/it's/g, 'its');",
      '}',
      'const AFTER_THE_REGEX = [2];',
    ].join('\n');

    expect(() => extractTopLevelDeclarations(source)).toThrow(/top-level bindings/);
  });

  it('raises rather than truncating when a declaration never closes', () => {
    expect(() =>
      extractTopLevelDeclarations('export function open(a: string) {\n  return a;')
    ).toThrow(/no closing line of its own/);
  });

  it('raises when a binding never terminates', () => {
    expect(() => extractTopLevelDeclarations('const dangling = [1, 2')).toThrow(/never terminates/);
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

  it('ignores a member access Prettier broke onto its own line', () => {
    // Found at `--print-width 80` against the real file: `(x as {...})\n.retired`
    // left a space before the dot that no other rule removed.
    expect(normalizeForHash('(stored as { retired: unknown[] })\n      .retired;')).toBe(
      normalizeForHash('(stored as { retired: unknown[] }).retired;')
    );
  });

  it('ignores a generic Prettier broke across lines', () => {
    // Found at `--print-width 60`: `Record<\n  string,\n  unknown\n>`.
    expect(normalizeForHash('const s: Record<\n  string,\n  unknown\n> = {};')).toBe(
      normalizeForHash('const s: Record<string, unknown> = {};')
    );
  });

  it('ignores whether a body ends with its own semicolon before the brace', () => {
    // Prettier moves the last statement of a body on and off its own line as the
    // print width changes, taking the semicolon with it. Measured: at
    // `--print-width 140` this single difference moved all eleven real pins.
    expect(normalizeForHash('{ backfill(store); }')).toBe(normalizeForHash('{ backfill(store) }'));
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
    expect(migrationClosure('0.59.0', sources(SOURCE))).toContain("store.set('seed', true);");
  });

  it('follows a helper that calls another helper', () => {
    const inner = helper('backfillInner', "store.set('inner', 1);");
    const outer = helper('backfillOuter', 'backfillInner(store);');
    const source = sourceWith(["  '0.60.0': backfillOuter,"], [outer, inner]);
    expect(migrationClosure('0.60.0', sources(source))).toContain("store.set('inner', 1);");
  });

  it('follows a helper into the constant that decides what it does', () => {
    // The DOR-1222 shape a call-only closure misses: the code is frozen and the
    // list it acts on is not. `migrateSidebarSectionPrefs` / `RETIRED_SIDEBAR_KEYS`
    // is the real pair.
    const source = sourceWith(
      ["  '0.60.0': backfillFromList,"],
      [
        "const RETIRED_KEYS = ['ungroupedSortMode'] as const;",
        helper('backfillFromList', 'for (const k of RETIRED_KEYS) store.set(k, null);'),
      ]
    );
    expect(migrationClosure('0.60.0', sources(source))).toContain('ungroupedSortMode');
  });

  it('does not pull in a helper the key never reaches', () => {
    expect(migrationClosure('0.59.0', sources(SOURCE))).not.toContain("store.set('other', 1);");
  });

  it('is unchanged by moving a declaration within the file', () => {
    const reordered = sourceWith(
      ["  '0.59.0': backfillSeed,", "  '0.60.0': backfillOther,"],
      [OTHER, SEED]
    );
    expect(migrationHash('0.59.0', sources(reordered))).toBe(
      migrationHash('0.59.0', sources(SOURCE))
    );
  });

  it('raises for a key that is not in the table', () => {
    expect(() => migrationClosure('9.9.9', sources(SOURCE))).toThrow(/not in CONFIG_MIGRATIONS/);
  });
});

describe('the import boundary (DOR-1732)', () => {
  /** A `config-schema.ts`-shaped file: an exported helper and the whole schema. */
  const SCHEMA = [
    '/**',
    ' * Convert a stored entry into a reference.',
    ' */',
    'export function toSidebarItemRef(entry: string): { kind: string; path: string } {',
    "  return { kind: 'agent', path: entry };",
    '}',
    '',
    'export const UserConfigSchema = z.object({',
    "  everyFieldTheAppHas: z.string().default('x'),",
    '});',
    '',
    'export const USER_CONFIG_DEFAULTS = UserConfigSchema.parse({});',
  ].join('\n');

  const CALLER = sourceWith(
    ["  '0.57.0': migrateSidebarMembers,"],
    [helper('migrateSidebarMembers', "store.set('pinned', toSidebarItemRef('a'));")]
  );

  it('follows a shipped key into a helper one module away', () => {
    // The bypass this closure was widened to close. `'0.57.0'` decides what
    // every upgrading install's sidebar members become, and the function that
    // decides it lives in `@dorkos/shared` — so before this, rewriting it left
    // every guard green (measured: all 382 of them).
    expect(migrationClosure('0.57.0', sources(CALLER, SCHEMA))).toContain(
      "return { kind: 'agent', path: entry };"
    );
  });

  it('moves the hash for a body edit and holds it for a prose edit', () => {
    // The two halves of the acceptance bar together: a guard that fired for
    // reworded TSDoc would be repinned reflexively and stop meaning anything,
    // and one that stayed quiet for a changed body is the bug itself.
    const pinned = migrationHash('0.57.0', sources(CALLER, SCHEMA));
    const reworded = SCHEMA.replace(
      'Convert a stored entry into a reference.',
      'Convert one STORED membership entry into a reference.'
    );
    const rewritten = SCHEMA.replace('path: entry }', 'path: entry.toLowerCase() }');

    expect(migrationHash('0.57.0', sources(CALLER, reworded))).toBe(pinned);
    expect(migrationHash('0.57.0', sources(CALLER, rewritten))).not.toBe(pinned);
  });

  it('never follows the whole config schema, but pins the line that derives from it', () => {
    // `UserConfigSchema` reaches every declaration in that file, and five
    // shipped keys reach it through `USER_CONFIG_DEFAULTS` — so following it
    // would move five pins for every ordinary field addition, which is how a
    // pin gets bumped without being read. The derivation itself is still
    // pinned, so swapping it for a literal is seen.
    const seeder = sourceWith(
      ["  '0.69.0': seedFromDefaults,"],
      [helper('seedFromDefaults', "store.set('memory', USER_CONFIG_DEFAULTS.memory);")]
    );
    const closure = migrationClosure('0.69.0', sources(seeder, SCHEMA));
    expect(closure).toContain('USER_CONFIG_DEFAULTS = UserConfigSchema.parse({})');
    expect(closure).not.toContain('everyFieldTheAppHas');
  });

  it('refuses a name both files declare rather than silently keeping one', () => {
    // A dropped declaration is a hole the pins cannot show: the closure would
    // hash whichever copy survived and stay stable while the other drifted.
    const collides = SCHEMA.replace('toSidebarItemRef', 'migrateSidebarMembers');
    expect(() => declarationPool(sources(CALLER, collides))).toThrow(
      /both declare migrateSidebarMembers/
    );
  });
});

describe('checkAppendOnly', () => {
  it('passes when every key matches its pin', () => {
    expect(checkAppendOnly(sources(SOURCE), PINS)).toMatchObject({ ok: true, problems: [] });
  });

  it('passes a comment-only edit inside a merged body', () => {
    // Deliberate, and the one place this rule is looser than the byte-identity
    // rule next door: a stale sentence inside a body stays correctable. Prose is
    // not what upgrading installs ran.
    const reworded = sourceWith(
      ["  '0.59.0': backfillSeed,", "  '0.60.0': backfillOther,"],
      [helper('backfillSeed', "store.set('seed', true);", 'reworded'), OTHER]
    );
    expect(checkAppendOnly(sources(reworded), PINS).ok).toBe(true);
  });

  it('fails when a merged body is edited in place', () => {
    const edited = sourceWith(
      ["  '0.59.0': backfillSeed,", "  '0.60.0': backfillOther,"],
      [helper('backfillSeed', "store.set('seed', false);"), OTHER]
    );

    const res = checkAppendOnly(sources(edited), PINS);
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

    const res = checkAppendOnly(sources(edited), PINS);
    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/"0\.60\.0" changed after it was pinned/);
  });

  it('fails an unpinned new key, and hands over the line to add', () => {
    const added = sourceWith(
      ["  '0.59.0': backfillSeed,", "  '0.60.0': backfillOther,", "  '0.61.0': backfillFresh,"],
      [SEED, OTHER, helper('backfillFresh', "store.set('fresh', 1);")]
    );

    const res = checkAppendOnly(sources(added), PINS);
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
      '0.59.0': migrationHash('0.59.0', sources(before)),
      '0.60.0': migrationHash('0.60.0', sources(before)),
    };
    const after = sourceWith(
      ["  '0.59.0': backfillShared,", "  '0.60.0': backfillShared,"],
      [helper('backfillShared', "store.set('shared', 2);")]
    );

    const res = checkAppendOnly(sources(after), pins);
    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/2 keys moved together \(0\.59\.0, 0\.60\.0\)/);
    expect(res.problems.join('\n')).toMatch(/backfillRoomsDefaults pattern/);
  });

  it('fails when a pinned key is removed from the table', () => {
    const dropped = sourceWith(["  '0.59.0': backfillSeed,"], [SEED, OTHER]);

    const res = checkAppendOnly(sources(dropped), PINS);
    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/"0\.60\.0" is pinned but is no longer/);
  });
});
