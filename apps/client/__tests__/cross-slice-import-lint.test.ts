import { resolve } from 'node:path';
import { ESLint, type Linter } from 'eslint';
import { describe, it, expect, beforeAll } from 'vitest';

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
 * would pass vacuously. Their source text, and the lifecycle that puts them
 * there, live in `lint-fixtures.ts`: writing and removing them from this file's
 * own hooks changed `src/` while other suites walked it, which is what DOR-1821
 * was. `globalSetup` now does both outside any worker's lifetime.
 */
const CLIENT_ROOT = resolve(__dirname, '..');
const LAYERS = resolve(CLIENT_ROOT, 'src/layers');

/**
 * Loading the app's flat config is a one-time ~6s cost per worker — it pulls in
 * typescript-eslint, three React plugins and a TS resolver. That is more than
 * the default 5s test budget on a loaded machine, so the whole suite shares one
 * instance and the cold start is paid in `beforeAll` (which gets its own
 * timeout) rather than inside whichever assertion happened to run first.
 *
 * `ignore: false` because `eslint.config.js` ignores the fixture slices, so that
 * a `pnpm lint` overlapping a test run does not report the violations they carry
 * on purpose. The option decides which files are SELECTED, not which rules run.
 */
const eslint = new ESLint({ cwd: CLIENT_ROOT, ignore: false });

/**
 * Lint one fixture through the app's real flat config and return only the
 * messages this rule produced.
 *
 * Asserts that ESLint actually READ the file first. Three of the five cases
 * below are negative — they expect an empty message list — and an empty list is
 * exactly what a file ESLint skipped produces. The skip is one edit away: drop
 * `ignore: false` above and every fixture falls under the `ignores` entry in
 * `eslint.config.js`, at which point `lintFiles` returns a single result
 * carrying only a "File ignored because of a matching ignore pattern" warning
 * and all three negatives pass on a file nothing looked at.
 *
 * So one result, and no ignore warning, before the messages are filtered.
 *
 * @param relativePath Path under `src/layers/`.
 * @returns The rule's messages for that file.
 */
async function lintFixture(relativePath: string): Promise<Linter.LintMessage[]> {
  const results = await eslint.lintFiles([resolve(LAYERS, relativePath)]);

  expect(results, `ESLint returned no result for ${relativePath}`).toHaveLength(1);
  const messages = results[0].messages;
  expect(
    messages.filter((m) => m.message.includes('File ignored')),
    `ESLint skipped ${relativePath} instead of linting it`
  ).toEqual([]);

  return messages.filter((m) => m.ruleId === 'fsd/no-cross-slice-relative-import');
}

describe('cross-slice relative import lint rule', () => {
  beforeAll(async () => {
    // Pay ESLint's config cold start here, on this hook's own budget. The
    // fixture slices are already on disk — `globalSetup` wrote them.
    await lintFixture('features/__slice-fixture-a__/ui/Ok.ts');
  }, 120_000);

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

  it('allows a relative path to the repo-root scripts/ directory', async () => {
    // The repo's shared source stripper lives at `scripts/lib/code-only.mjs`,
    // outside every package. Four guards here read source with it, and there is
    // no slice at the other end of that path — so the message this rule would
    // print ("reach it through its barrel") names something that does not
    // exist. What must NOT change is the sibling-slice case above, which is why
    // both live in this file.
    expect(await lintFixture('features/__slice-fixture-a__/ui/OutsideSrc.ts')).toEqual([]);
  });

  it('still reports a deep relative import into another workspace package', async () => {
    // The exemption above is a PREFIX, not "anything outside src/". This fixture
    // leaves `src/` by the identical number of hops and is a real violation of
    // the same encapsulation idea one level up — and unlike the scripts path it
    // HAS a correct spelling to be redirected to (`@dorkos/shared/transport`).
    // Nothing in the tree does it today; this is what keeps that true.
    const errors = await lintFixture('features/__slice-fixture-a__/ui/OutsidePackage.ts');

    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe(2);
    // And it names the fix that exists. "Reach it through its barrel" would send
    // the reader looking for a slice barrel in `packages/shared`, which has none.
    expect(errors[0].message).toContain('@dorkos/<package>');
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
