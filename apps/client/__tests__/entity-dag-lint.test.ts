import { resolve } from 'node:path';
import { ESLint, type Linter } from 'eslint';
import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Guards the cross-entity DAG rule (DOR-205): entity slices may depend on each
 * other, but never in a circle. `.claude/rules/fsd-layers.md` carries the
 * direction half; `import-x/no-cycle` in `eslint.config.js` carries this half.
 *
 * This test exists because that rule fails OPEN, and silently. Three ways were
 * hit while building it, each of which produced a clean green lint over a graph
 * the rule had never read: `import-x/parsers` missing, so no `.ts` dependency
 * could be parsed and the walk ended at the first import; the resolver not
 * loading, so the `@/` alias went unresolved; and the whole thing wired through
 * `eslint-plugin-import` instead of import-x, which detected nothing at all.
 * None of them raised an error. So a green `pnpm lint` is NOT evidence the rule
 * ran — only a cycle it actually catches is, which is what this fixture is.
 *
 * The fixture is shaped like a REAL cross-entity cycle, and why it is shaped
 * that way — plus its exact source text — lives in `lint-fixtures.ts`, which
 * writes it. It is written there rather than here because creating and removing
 * directories inside `src/` WHILE other suites walk `src/` is what DOR-1821
 * was: `globalSetup` now writes the slices before any worker starts and removes
 * them after the last one finishes, so no walker can observe the transition.
 */
const CLIENT_ROOT = resolve(__dirname, '..');

/**
 * `apps/client/src/layers/entities`, where the fixture slices sit.
 *
 * Spelled here rather than imported from `lint-fixtures.ts`, which resolves its
 * own paths from `import.meta.url`: this suite runs under jsdom, where that is
 * an `http:` URL and `fileURLToPath` refuses it. The two files agree on one
 * short path string instead of sharing a module across environments.
 */
const ENTITIES = resolve(CLIENT_ROOT, 'src/layers/entities');

/**
 * Loading the app's flat config is a one-time ~6s cost per worker, and this
 * suite is no longer the only one paying it — `cross-slice-import-lint.test.ts`
 * instantiates ESLint too, and the two run in parallel workers. On a loaded
 * machine that pushed the first assertion here past the default 5s budget, so
 * the instance is shared and the cold start happens in `beforeAll`.
 *
 * `ignore: false` because `eslint.config.js` ignores the fixture slices, so that
 * a `pnpm lint` overlapping a test run does not report the violations they
 * carry on purpose. The option decides which files are SELECTED, not which rules
 * run: every rule below still evaluates exactly as it does on real source.
 */
const eslint = new ESLint({ cwd: CLIENT_ROOT, ignore: false });

/**
 * Lint one fixture file through the app's real flat config.
 *
 * Asserts that ESLint actually READ the file before any caller judges what it
 * said. Two of the cases below are negative — they expect an empty message list
 * — and an empty list is exactly what a file ESLint skipped produces. The skip
 * is one edit away: drop `ignore: false` above and every fixture falls under the
 * `ignores` entry in `eslint.config.js`, at which point `lintFiles` returns a
 * single result carrying only a "File ignored because of a matching ignore
 * pattern" warning and both negatives pass on a file nothing looked at.
 *
 * So one result, and no ignore warning, before the messages are handed back.
 *
 * @param slice - A fixture slice directory name under `src/layers/entities`.
 */
async function lintSliceEntry(slice: string): Promise<Linter.LintMessage[]> {
  const entry = resolve(ENTITIES, slice, 'index.ts');
  const results = await eslint.lintFiles([entry]);

  expect(results, `ESLint returned no result for ${slice}/index.ts`).toHaveLength(1);
  const messages = results[0].messages;
  expect(
    messages.filter((m) => m.message.includes('File ignored')),
    `ESLint skipped ${slice}/index.ts instead of linting it`
  ).toEqual([]);

  return messages;
}

const cycleErrors = (messages: Linter.LintMessage[]): Linter.LintMessage[] =>
  messages.filter((m) => m.ruleId === 'import-x/no-cycle');

describe('cross-entity DAG lint rule', () => {
  beforeAll(async () => {
    // Pay ESLint's config cold start here, on this hook's own budget. The
    // fixture slices are already on disk — `globalSetup` wrote them.
    await lintSliceEntry('__dag-fixture-ok__');
  }, 120_000);

  it('reports a cycle that closes through the alias and two barrels', async () => {
    const errors = cycleErrors(await lintSliceEntry('__dag-fixture-x__'));

    expect(errors).toHaveLength(1);
    // severity 2 = error. The lint gate only fails on errors, so a warning here
    // would let a cycle land.
    expect(errors[0].severity).toBe(2);
  });

  it('leaves an acyclic cross-slice dependency alone', async () => {
    // The other half of the discrimination: a rule that flagged every alias
    // import would pass the test above while telling us nothing. This also
    // fails if the resolver breaks in the direction of over-reporting.
    expect(cycleErrors(await lintSliceEntry('__dag-fixture-ok__'))).toHaveLength(0);
  });

  it('does not let a deep import past a sibling barrel through', async () => {
    // The direction rule's other machine-checked half: siblings are reachable
    // only via their barrel. `deep.ts` is written by `globalSetup` alongside the
    // slice it sits in, for the same reason as the rest of them.
    const deep = resolve(ENTITIES, '__dag-fixture-ok__', 'model', 'deep.ts');

    const eslint = new ESLint({ cwd: CLIENT_ROOT, ignore: false });
    const [result] = await eslint.lintFiles([deep]);
    const restricted = result.messages.filter((m) => m.ruleId === 'no-restricted-imports');

    expect(restricted).toHaveLength(1);
    expect(restricted[0].severity).toBe(2);
  });
});
