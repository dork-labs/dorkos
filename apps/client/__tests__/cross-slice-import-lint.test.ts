import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ESLint, type Linter } from 'eslint';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * Guards the slice-encapsulation rule (DOR-1010): a relative path may not leave
 * the slice it is written in.
 *
 * The rule exists because the `no-restricted-imports` blocks in
 * `eslint.config.js` match the specifier as a string, so they see only the
 * aliased spelling of a deep import. `../../composer/ui/ClearArmedHint` is the
 * same violation and passed lint clean until this rule; two of them reached a
 * branch before a human caught them.
 *
 * Every case below is a DISCRIMINATION, not a smoke test. A rule that simply
 * banned `../../` would pass the first case and the fourth while breaking the
 * second, third and fifth — and those three are ordinary, deliberate, and
 * everywhere in this codebase. The fixtures are shaped so that only real path
 * arithmetic passes all five.
 *
 * The slices are written into the real source tree rather than a tmpdir because
 * the rule is scoped to `src/layers/**` and derives the slice from the file's
 * own path; a fixture outside that tree would be skipped and every assertion
 * would pass vacuously. They are removed in `afterAll`, and `.gitignore` carries
 * a line for them so an interrupted run cannot leave one committable.
 */
const CLIENT_ROOT = resolve(__dirname, '..');
const LAYERS = resolve(CLIENT_ROOT, 'src/layers');

/**
 * Loading the app's flat config is a one-time ~6s cost per worker — it pulls in
 * typescript-eslint, three React plugins and a TS resolver. That is more than
 * the default 5s test budget on a loaded machine, so the whole suite shares one
 * instance and the cold start is paid in `beforeAll` (which gets its own
 * timeout) rather than inside whichever assertion happened to run first.
 */
const eslint = new ESLint({ cwd: CLIENT_ROOT });

/** Every fixture directory, for teardown. Kept in sync with `.gitignore`. */
const FIXTURE_DIRS = [
  resolve(LAYERS, 'features/__slice-fixture-a__'),
  resolve(LAYERS, 'features/__slice-fixture-b__'),
  resolve(LAYERS, 'shared/__slice-fixture-segment__'),
];

/**
 * Write one fixture file, creating its directories.
 *
 * @param relativePath Path under `src/layers/`.
 * @param source File contents.
 * @returns The absolute path written.
 */
function writeFixture(relativePath: string, source: string): string {
  const absolute = resolve(LAYERS, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source, 'utf-8');
  return absolute;
}

/**
 * Lint one fixture through the app's real flat config and return only the
 * messages this rule produced.
 *
 * @param relativePath Path under `src/layers/`.
 * @returns The rule's messages for that file.
 */
async function lintFixture(relativePath: string): Promise<Linter.LintMessage[]> {
  const results = await eslint.lintFiles([resolve(LAYERS, relativePath)]);
  return results
    .flatMap((r) => r.messages)
    .filter((m) => m.ruleId === 'fsd/no-cross-slice-relative-import');
}

describe('cross-slice relative import lint rule', () => {
  beforeAll(async () => {
    // The neighbour being reached into. Real, so the fixture is a genuine
    // resolvable import and not a dangling string.
    writeFixture('features/__slice-fixture-b__/ui/Thing.ts', 'export const thing = 1;\n');
    writeFixture('features/__slice-fixture-b__/index.ts', "export { thing } from './ui/Thing';\n");

    // Slice A's own internals, at two depths.
    writeFixture('features/__slice-fixture-a__/model/state.ts', 'export const state = 1;\n');

    writeFixture(
      'features/__slice-fixture-a__/ui/Bad.ts',
      "import { thing } from '../../__slice-fixture-b__/ui/Thing';\nexport const bad = () => thing;\n"
    );
    writeFixture(
      'features/__slice-fixture-a__/ui/Ok.ts',
      "import { state } from '../model/state';\nimport { thing } from '@/layers/features/__slice-fixture-b__';\nexport const ok = () => state + thing;\n"
    );
    // Nested one segment deeper, so `../../` still lands inside slice A. This is
    // the case a depth-counting string pattern gets wrong.
    writeFixture(
      'features/__slice-fixture-a__/ui/status/Deep.ts',
      "import { state } from '../../model/state';\nexport const deep = () => state;\n"
    );
    writeFixture(
      'features/__slice-fixture-a__/__tests__/mock.test.ts',
      "vi.mock('../../__slice-fixture-b__/ui/Thing', () => ({ thing: 2 }));\nexport const mocked = 1;\n"
    );

    // `shared/` is sliceless: its top-level directories are segments, so a
    // relative hop between them stays inside the unit.
    writeFixture(
      'shared/__slice-fixture-segment__/uses-lib.ts',
      "import { cn } from '../lib/utils';\nexport const usesLib = cn;\n"
    );

    // Pay ESLint's config cold start here, on this hook's own budget.
    await lintFixture('features/__slice-fixture-a__/ui/Ok.ts');
  }, 120_000);

  afterAll(() => {
    for (const dir of FIXTURE_DIRS) rmSync(dir, { recursive: true, force: true });
  });

  it('reports a relative path that reaches into a sibling slice', async () => {
    const errors = await lintFixture('features/__slice-fixture-a__/ui/Bad.ts');

    expect(errors).toHaveLength(1);
    // severity 2 = error. The lint gate only fails on errors, so a warning here
    // would let the violation land.
    expect(errors[0].severity).toBe(2);
    expect(errors[0].message).toContain('features/__slice-fixture-a__');
  });

  it('leaves within-slice relative imports and aliased barrel imports alone', async () => {
    expect(await lintFixture('features/__slice-fixture-a__/ui/Ok.ts')).toEqual([]);
  });

  it('allows `../../` when the importing file is deep enough to stay in its slice', async () => {
    expect(await lintFixture('features/__slice-fixture-a__/ui/status/Deep.ts')).toEqual([]);
  });

  it('reports a cross-slice relative path in vi.mock, which no import declaration carries', async () => {
    const errors = await lintFixture('features/__slice-fixture-a__/__tests__/mock.test.ts');

    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe(2);
  });

  it('treats the sliceless shared/ layer as one unit', async () => {
    expect(await lintFixture('shared/__slice-fixture-segment__/uses-lib.ts')).toEqual([]);
  });
});
