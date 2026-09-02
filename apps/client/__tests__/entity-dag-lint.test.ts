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
 * The fixture lives under `src/layers/entities/` on purpose: the rule is scoped
 * to that path, and `no-cycle` resolves real files off disk, so a virtual
 * `lintText` path would prove nothing.
 */
const CLIENT_ROOT = resolve(__dirname, '..');
const FIXTURE_DIR = resolve(CLIENT_ROOT, 'src/layers/entities/__dag-fixture__');

/** Lint one fixture file through the app's real flat config. */
async function lintFixture(file: string): Promise<ESLint.LintResult[]> {
  const eslint = new ESLint({ cwd: CLIENT_ROOT });
  return eslint.lintFiles([resolve(FIXTURE_DIR, file)]);
}

const cycleErrors = (results: ESLint.LintResult[]): Linter.LintMessage[] =>
  results.flatMap((r) => r.messages).filter((m) => m.ruleId === 'import-x/no-cycle');

describe('cross-entity DAG lint rule', () => {
  beforeAll(() => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    // `acyclic.ts` depends on `leaf.ts` and nothing depends back on it.
    writeFileSync(resolve(FIXTURE_DIR, 'leaf.ts'), 'export const leaf = () => 1;\n', 'utf-8');
    writeFileSync(
      resolve(FIXTURE_DIR, 'acyclic.ts'),
      "import { leaf } from './leaf';\nexport const acyclic = () => leaf();\n",
      'utf-8'
    );
    // A two-hop circle: `a -> b -> a`.
    writeFileSync(
      resolve(FIXTURE_DIR, 'cycle-a.ts'),
      "import { b } from './cycle-b';\nexport const a = () => b();\n",
      'utf-8'
    );
    writeFileSync(
      resolve(FIXTURE_DIR, 'cycle-b.ts'),
      "import { a } from './cycle-a';\nexport const b = () => a();\n",
      'utf-8'
    );
    // Reaches a real sibling slice through the `@/` alias and the barrel — the
    // exact import shape every cross-entity edge uses.
    writeFileSync(
      resolve(FIXTURE_DIR, 'alias.ts'),
      "import { sessionKeys } from '@/layers/entities/session';\nexport const alias = () => sessionKeys;\n",
      'utf-8'
    );
  });

  afterAll(() => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('reports a cycle as an error, not a warning', async () => {
    const errors = cycleErrors(await lintFixture('cycle-a.ts'));

    expect(errors).toHaveLength(1);
    // severity 2 = error. The lint gate only fails on errors, so a warning here
    // would let a cycle land.
    expect(errors[0].severity).toBe(2);
  });

  it('leaves an acyclic dependency alone', async () => {
    // The other half of the discrimination: a rule that flagged everything would
    // pass the test above while telling us nothing.
    expect(cycleErrors(await lintFixture('acyclic.ts'))).toHaveLength(0);
  });

  it('resolves the @/ alias, so cross-slice hops are actually walked', async () => {
    // The resolver is the piece most likely to break silently on a dependency
    // bump, and when it breaks `no-cycle` still reports nothing at all. The two
    // tests above cannot see that: they only exercise relative imports, which
    // the built-in node resolution handles. So pin the alias directly — if
    // `@/layers/entities/session` stops resolving, this goes red while every
    // other signal stays green.
    const eslint = new ESLint({
      cwd: CLIENT_ROOT,
      overrideConfig: { rules: { 'import-x/no-unresolved': 'error' } },
    });
    const [result] = await eslint.lintFiles([resolve(FIXTURE_DIR, 'alias.ts')]);
    const unresolved = result.messages.filter((m) => m.ruleId === 'import-x/no-unresolved');

    expect(unresolved).toHaveLength(0);
  });
});
