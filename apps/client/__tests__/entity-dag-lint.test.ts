import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ESLint, type Linter } from 'eslint';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

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
 * The fixture is shaped like a REAL cross-entity cycle, and that shape is the
 * point. A two-file relative cycle (`a.ts` <-> `b.ts`) is depth 1 and would stay
 * green under a `maxDepth: 1` rule option while every genuine cycle went
 * undetected — the perf note in `eslint.config.js` makes adding `maxDepth` a
 * plausible future edit, so the guard has to be sensitive to it. Every real
 * cross-entity cycle closes through the `@/` alias and two barrels, so this one
 * does too: x/index -> x/model/a -> @/…/y -> y/index -> y/model/b -> @/…/x, a
 * depth-4 walk that also proves alias resolution works.
 *
 * The slices sit at the TOP level of `entities/`, not nested under one fixture
 * root, because a nested `@/layers/entities/__dag-fixture__/y` would itself trip
 * the barrel-only restriction in `eslint.config.js`. Real slices are top-level;
 * the fixture matches.
 */
const CLIENT_ROOT = resolve(__dirname, '..');
const ENTITIES = resolve(CLIENT_ROOT, 'src/layers/entities');
/** Every fixture slice, for creation and for teardown. Kept in sync with `.gitignore`. */
const FIXTURE_SLICES = ['__dag-fixture-x__', '__dag-fixture-y__', '__dag-fixture-ok__'];

/** Write one fixture slice: a barrel re-exporting a single `model/` module. */
function writeSlice(slice: string, moduleName: string, moduleSource: string): void {
  const dir = resolve(ENTITIES, slice);
  mkdirSync(resolve(dir, 'model'), { recursive: true });
  writeFileSync(
    resolve(dir, 'index.ts'),
    `export { ${moduleName} } from './model/${moduleName}';\n`,
    'utf-8'
  );
  writeFileSync(resolve(dir, 'model', `${moduleName}.ts`), moduleSource, 'utf-8');
}

/**
 * Loading the app's flat config is a one-time ~6s cost per worker, and this
 * suite is no longer the only one paying it — `cross-slice-import-lint.test.ts`
 * instantiates ESLint too, and the two run in parallel workers. On a loaded
 * machine that pushed the first assertion here past the default 5s budget, so
 * the instance is shared and the cold start happens in `beforeAll`.
 */
const eslint = new ESLint({ cwd: CLIENT_ROOT });

/** Lint one fixture file through the app's real flat config. */
async function lintSliceEntry(slice: string): Promise<Linter.LintMessage[]> {
  const results = await eslint.lintFiles([resolve(ENTITIES, slice, 'index.ts')]);
  return results.flatMap((r) => r.messages);
}

const cycleErrors = (messages: Linter.LintMessage[]): Linter.LintMessage[] =>
  messages.filter((m) => m.ruleId === 'import-x/no-cycle');

describe('cross-entity DAG lint rule', () => {
  beforeAll(async () => {
    // x and y close a circle through each other's barrels, via the `@/` alias.
    writeSlice(
      '__dag-fixture-x__',
      'x',
      "import { y } from '@/layers/entities/__dag-fixture-y__';\nexport const x = () => y();\n"
    );
    writeSlice(
      '__dag-fixture-y__',
      'y',
      "import { x } from '@/layers/entities/__dag-fixture-x__';\nexport const y = () => x();\n"
    );
    // The control: same alias, same barrel shape, real sibling slice, no circle
    // back — `session` cannot reach a fixture slice.
    writeSlice(
      '__dag-fixture-ok__',
      'ok',
      "import { sessionKeys } from '@/layers/entities/session';\nexport const ok = () => sessionKeys;\n"
    );

    // Pay ESLint's config cold start here, on this hook's own budget.
    await lintSliceEntry('__dag-fixture-ok__');
  }, 120_000);

  afterAll(() => {
    for (const slice of FIXTURE_SLICES) {
      rmSync(resolve(ENTITIES, slice), { recursive: true, force: true });
    }
  });

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
    // only via their barrel.
    const dir = resolve(ENTITIES, '__dag-fixture-ok__', 'model');
    writeFileSync(
      resolve(dir, 'deep.ts'),
      "import { sessionKeys } from '@/layers/entities/session/api/query-keys';\nexport const deep = () => sessionKeys;\n",
      'utf-8'
    );

    const eslint = new ESLint({ cwd: CLIENT_ROOT });
    const [result] = await eslint.lintFiles([resolve(dir, 'deep.ts')]);
    const restricted = result.messages.filter((m) => m.ruleId === 'no-restricted-imports');

    expect(restricted).toHaveLength(1);
    expect(restricted[0].severity).toBe(2);
  });
});
