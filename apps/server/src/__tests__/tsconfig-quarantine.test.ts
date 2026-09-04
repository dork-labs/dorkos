/**
 * The guard on the type-quarantine in `apps/server/tsconfig.json` (DOR-508).
 *
 * ## Why this file exists
 *
 * DOR-508 closed a hole where 416 server test files were in no tsc program at
 * all, so a `@ts-expect-error` written in one could never fail and a field rename
 * that broke only a type stayed green. 108 of those files were already too broken
 * to include, so they sit in that tsconfig's `exclude` as a quarantine.
 *
 * A quarantine is a promise to shrink, and the first version of it made that
 * promise in a code comment. Nothing enforced it. Adding one more line to an
 * `exclude` array reads as routine config noise in a diff — which is the same
 * silent-regression shape DOR-508 was about, reintroduced one level up. So the
 * promise is asserted here instead: the count is pinned, and moving it is a
 * deliberate edit to a file named after the thing it protects.
 *
 * ## What each assertion buys
 *
 * - **The count is pinned.** Lowering {@link QUARANTINE_BASELINE} is how progress
 *   gets recorded; raising it is what a reviewer is meant to notice and question.
 *   Direction is not machine-enforced — a baseline in the tree can always be
 *   edited — but it cannot be done invisibly, and that is the whole difference
 *   from a comment.
 * - **Only `*.test.ts` may be quarantined.** This is the non-obvious part of how
 *   `exclude` behaves. It drops a file from the program's ROOTS, not from the
 *   program: a file that an included file IMPORTS is pulled back in and checked
 *   regardless. The shared fixture modules under `__tests__`
 *   (`sdk-scenarios.ts`, `codex-scenarios.ts`, `durable-turn-harness.ts`, …) are
 *   imported by test files, so quarantining one is inert. One entry shipped that
 *   way and had to be removed; this assertion is why it cannot happen twice.
 * - **Every entry names a file that exists.** A rename or deletion otherwise
 *   leaves an entry that excludes nothing and looks like real coverage.
 * - **No globs.** File granularity on purpose: a directory pattern would silently
 *   exempt every NEW test written under it, which is the coverage this bought.
 * - **Sorted and unique.** Keeps the diff on a 100-plus-line array readable, so a
 *   line appearing in the middle of it is visible rather than lost.
 *
 * ## What it does not catch
 *
 * It does not verify the `// N` error counts beside each entry, which would mean
 * running tsc once per file. Those are a day-one sizing hint for whoever picks a
 * file up, not a live assertion — quarantine is per-file and all-or-nothing, so a
 * count only goes stale if someone edits a quarantined test without freeing it.
 *
 * It also cannot tell whether a quarantined file still deserves to be there. The
 * honest check for that is deleting the line and running `pnpm --filter
 * @dorkos/server typecheck`, which is exactly the workflow the count is for.
 *
 * @module __tests__/tsconfig-quarantine
 */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** `apps/server`, resolved from this file rather than from the cwd. */
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const TSCONFIG_PATH = path.join(SERVER_ROOT, 'tsconfig.json');

/**
 * The `exclude` entries that are structural rather than quarantine, so the
 * quarantine is derived by subtraction instead of by pattern-matching paths.
 * Deriving it the other way (anything containing `__tests__`) would miss an entry
 * that quarantines something else, which is a case worth failing on.
 */
const STRUCTURAL_EXCLUDES = ['node_modules', 'dist', 'src/core-extensions/**'];

/**
 * How many test files are quarantined right now.
 *
 * DOR-508 opened the quarantine at 109 and immediately removed one inert entry.
 * DOR-635 freed `permission-preview.test.ts` (its single error was a
 * `as ShapePackageManifest` cast papering over an incomplete `layout` fixture).
 * **Only ever lower this.** Lowering it means a file was fixed and freed; raising
 * it means a test file was given up on, which needs a reason in review.
 */
const QUARANTINE_BASELINE = 105;

/**
 * The `exclude` array from the server tsconfig.
 *
 * Parsed with TypeScript's own reader because that file carries `//` comments,
 * which `JSON.parse` rejects. A hand-rolled comment stripper would be one more
 * thing that can quietly return the wrong array and make this test vacuous.
 */
function readExclude(): string[] {
  const text = readFileSync(TSCONFIG_PATH, 'utf-8');
  const parsed = ts.parseConfigFileTextToJson(TSCONFIG_PATH, text);
  expect(parsed.error, `could not parse ${TSCONFIG_PATH}`).toBeUndefined();
  const exclude = (parsed.config as { exclude?: unknown })?.exclude;
  expect(Array.isArray(exclude), 'tsconfig.json has no exclude array').toBe(true);
  return exclude as string[];
}

const EXCLUDE = readExclude();
const QUARANTINE = EXCLUDE.filter((entry) => !STRUCTURAL_EXCLUDES.includes(entry));

describe('the tsconfig type-quarantine only shrinks', () => {
  it('read a real exclude array', () => {
    // Every assertion below is vacuously green against an empty list, which is the
    // one way this test could stop doing its job without saying so.
    expect(EXCLUDE).toContain('node_modules');
    expect(QUARANTINE.length).toBeGreaterThan(0);
  });

  it(`holds exactly ${QUARANTINE_BASELINE} entries`, () => {
    const delta = QUARANTINE.length - QUARANTINE_BASELINE;
    expect(
      QUARANTINE.length,
      delta > 0
        ? `\nThe quarantine GREW by ${delta}. A test file was excluded from typechecking.\n\n` +
            `If that is deliberate, raise QUARANTINE_BASELINE in this file and say why in the ` +
            `PR — it is a step back from what DOR-508 bought, not a config detail.\n` +
            `Otherwise fix the type errors instead: the file is checked, and that is the point.`
        : delta < 0
          ? `\nThe quarantine SHRANK by ${-delta} — nice. Lower QUARANTINE_BASELINE in this file ` +
            `to ${QUARANTINE.length} to lock the progress in, so it cannot silently come back.`
          : ''
    ).toBe(QUARANTINE_BASELINE);
  });

  it('quarantines only *.test.ts files, never a shared fixture module', () => {
    const notTests = QUARANTINE.filter((entry) => !entry.endsWith('.test.ts'));
    expect(
      notTests,
      notTests.length
        ? `\n${notTests.join('\n')}\n\n` +
            `Only files that nothing imports can be quarantined. \`exclude\` drops a file from ` +
            `the program's ROOTS, not from the program — anything an included file imports is ` +
            `pulled back in and typechecked anyway.\n\n` +
            `So quarantining a shared fixture module under __tests__ does nothing at all: it ` +
            `still has to be type-correct, and the entry just makes it look covered. Fix the ` +
            `fixture instead.`
        : ''
    ).toEqual([]);
  });

  it('names files that still exist', () => {
    const missing = QUARANTINE.filter((entry) => !existsSync(path.join(SERVER_ROOT, entry)));
    expect(
      missing,
      missing.length
        ? `\n${missing.join('\n')}\n\n` +
            `These quarantine entries point at files that are gone. A renamed or deleted test ` +
            `leaves an entry that excludes nothing, so the list stops describing reality and ` +
            `the count overstates the work left. Remove them.`
        : ''
    ).toEqual([]);
  });

  it('lists exact file paths, not directory globs', () => {
    const globs = QUARANTINE.filter((entry) => entry.includes('*'));
    expect(
      globs,
      globs.length
        ? `\n${globs.join('\n')}\n\n` +
            `The quarantine is per-file on purpose. A directory glob would also exempt every ` +
            `NEW test file written under it, and having new tests checked from the day they are ` +
            `written is most of what DOR-508 bought.`
        : ''
    ).toEqual([]);
  });

  it('stays sorted and free of duplicates', () => {
    expect(QUARANTINE, 'quarantine entries must be sorted, so the diff stays readable').toEqual(
      [...QUARANTINE].sort()
    );
    expect(new Set(QUARANTINE).size, 'a duplicated entry hides a second one').toBe(
      QUARANTINE.length
    );
  });
});
