/**
 * The roots that test this engine — the ONE list, read by two files that must
 * not disagree about it.
 *
 * `capabilities-census.test.ts` walks these for the test titles it holds the
 * contract against. `turbo-census-inputs.test.ts` checks that turbo HASHES every
 * one of them, so a renamed title in any of them cannot replay a cached green in
 * the merge queue. Those are two halves of one promise, and they were two
 * separate lists until a fifth root was added to the census and not to the
 * guard: the guard stayed green over an input it was supposed to require
 * (DOR-1895 review). A shared module is what makes that particular drift
 * impossible rather than merely noticed.
 *
 * Not a `.test.ts`, deliberately: a test file imported by another test file has
 * its suites registered twice, once in each importer.
 *
 * @module __tests__/census-test-roots
 */

/** One directory the census reads test titles out of. */
export interface CensusTestRoot {
  /** Repo-relative directory, walked recursively. */
  readonly dir: string;
  /** Which file names in it count. */
  readonly match: RegExp;
  /**
   * A floor on how many files the walk must find there.
   *
   * Per root, so a directory that moves or a file renamed out of a pattern is a
   * red rather than a quietly smaller census.
   */
  readonly least: number;
}

/**
 * Every root, and why it is one.
 *
 * The test plan's T8 named three; the fourth is the pair of Codex skill readers
 * (`scan-skill-commands`, `skill-parity`), which is where SK-08's frontmatter
 * dialect and J-15's parity promise are actually asserted — the contract's own
 * §15 counts them as part of this surface, and leaving them out would have meant
 * calling SK-08 uncovered while its tests sat six directories away.
 *
 * The fifth is `routes/__tests__/harness.test.ts`, added when TR-08 shipped
 * (DOR-1895). That row is "a person asks from the app", and the only place it is
 * asserted is over HTTP — the person bar, the `409`, the sweep as an exact tree
 * diff, the card the route does not wait for. Without this root the row would
 * have had to claim no coverage to keep the census green, which is the exact
 * false cell it exists to catch. One FILE rather than the directory, because
 * nothing else in `routes/__tests__` is about this engine.
 *
 * The sixth is the T7 browser spec (DOR-1896). Three rows now cite it — VC-01,
 * VC-02 and TR-08 — because a browser is the only place their claim is really
 * settled: that the page a person opens reads their own folder, and that the
 * sentence it draws is the engine's rather than a paraphrase. Without this root
 * those three would be citing a file nothing checks, which is the same false
 * cell as citing one that does not exist. The DIRECTORY rather than the file,
 * because it is a directory that exists for this subject and a second harness
 * spec belongs in it.
 *
 * All but the first are in other packages or other services, which is the whole
 * reason the turbo `inputs` override exists.
 */
export const TEST_ROOTS: readonly CensusTestRoot[] = [
  { dir: 'packages/harness/src', match: /\.test\.ts$/, least: 45 },
  { dir: 'apps/server/src/services/harness/__tests__', match: /\.test\.ts$/, least: 9 },
  { dir: 'packages/cli/src/__tests__', match: /^harness-sync.*\.test\.ts$/, least: 2 },
  {
    dir: 'apps/server/src/services/runtimes/codex/__tests__',
    match: /^(?:scan-skill-commands|skill-parity)\.test\.ts$/,
    least: 2,
  },
  { dir: 'apps/server/src/routes/__tests__', match: /^harness\.test\.ts$/, least: 1 },
  { dir: 'apps/e2e/tests/harness', match: /\.spec\.ts$/, least: 1 },
] as const;
