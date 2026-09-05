/**
 * Drift guard for the root `vitest.config.ts` project list.
 *
 * AGENTS.md tells every agent and every developer to verify with a targeted
 * `pnpm vitest run <path>` from the repo root, and that command only reaches a
 * package the root config registers as a project. For most of this repo's life
 * the list named eight of the eighteen packages that have tests, so the
 * documented loop answered "No test files found, exiting with code 1" for ~168
 * test files across ten packages (DOR-670).
 *
 * That failure is not a false green — the command exits 1 and turbo still runs
 * everything — but it is worse than a plain gap, because it is indistinguishable
 * from a broken test. The reader concludes the file is broken and starts
 * debugging code that was never executed.
 *
 * Nothing detected the gap because nothing connected the two facts: a package
 * declares a `test` script, and the root config lists it as a project. That is
 * what this file connects, and it is why the fix is a guard rather than only a
 * longer list. Adding a package with tests and forgetting the config entry is
 * the single mistake that produced DOR-670, and it is a mistake nobody makes on
 * purpose — so it has to fail here rather than be remembered.
 *
 * The second half of the file guards that same list from the other side: every
 * project it names must honour the pre-push gate's `VITEST_RETRY` budget. Same
 * shape of mistake, same absence of a natural moment of discovery — see the
 * describe block's own note for what it cost (DOR-1772).
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import rootConfig from '../../vitest.config.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/**
 * The workspace globs from `pnpm-workspace.yaml`, hard-coded for the same reason
 * `assert-tests-executed.sh` hard-codes them: these are the workspace's only two
 * globs, and reading YAML to learn that would buy nothing. A third glob added
 * later cannot make this test lie — its packages would go unenumerated, so a
 * missing project entry would go unnoticed but a stale one would still fail.
 */
const WORKSPACE_DIRS = ['apps', 'packages'] as const;

/** Workspace-relative paths of every package whose `package.json` declares a `test` script. */
function packagesWithTests(): string[] {
  const found: string[] = [];
  for (const dir of WORKSPACE_DIRS) {
    for (const entry of readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = path.join(repoRoot, dir, entry.name, 'package.json');
      let raw: string;
      try {
        raw = readFileSync(manifest, 'utf8');
      } catch {
        continue; // Not a package (no manifest) — nothing to register.
      }
      const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) found.push(`${dir}/${entry.name}`);
    }
  }
  return found.sort();
}

/**
 * The declared projects. `scripts` is dropped: it is repo-root tooling outside
 * the pnpm workspaces, so it has no `package.json` of its own to enumerate and
 * is registered by hand.
 */
function declaredWorkspaceProjects(): string[] {
  const projects = rootConfig.test?.projects;
  expect(Array.isArray(projects)).toBe(true);
  return (projects as string[]).filter((p) => p !== 'scripts').sort();
}

describe('root vitest project list', () => {
  it('registers every workspace package that declares a `test` script', () => {
    // A package missing here is DOR-670 all over again: `pnpm vitest run
    // <path>` into it exits 1 with "No test files found", which reads as a
    // broken test rather than an unregistered package.
    expect(declaredWorkspaceProjects()).toEqual(packagesWithTests());
  });

  it('registers the repo-root `scripts` project, which no workspace glob covers', () => {
    // `scripts/` is not a pnpm workspace, so the assertion above cannot see it,
    // and dropping it would silently take these very tests out of the targeted
    // loop.
    expect(rootConfig.test?.projects).toContain('scripts');
  });
});

/**
 * The config filenames Vitest resolves for a project, in the order it tries
 * them. `apps/obsidian-plugin` is the reason the order is written down rather
 * than assumed: it has both, and only the `vitest.config.ts` is its test config
 * (the `vite.config.ts` is a `lib` build). `apps/client` is the reason the
 * fallback exists at all — its test config lives inside `vite.config.ts`.
 */
const CONFIG_FILENAMES = ['vitest.config.ts', 'vite.config.ts'] as const;

/**
 * The exact expression every project wires `retry` to, whitespace-collapsed so
 * Prettier's line-wrapping cannot fail the comparison. One idiom on purpose:
 * `apps/server` and `packages/relay` wrote it first and every other project
 * copies it, so a reader who has understood one has understood all 21.
 */
const CANONICAL_RETRY = 'process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0';

/** The path of the config file Vitest would load for a registered project. */
function configPathFor(project: string): string {
  for (const filename of CONFIG_FILENAMES) {
    const candidate = path.join(repoRoot, project, filename);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Project "${project}" is registered in the root vitest.config.ts but has none of ${CONFIG_FILENAMES.join(', ')}.`
  );
}

/**
 * The source text of `test.retry` in a config's `defineConfig({ … })` argument,
 * or `undefined` when the config does not set it.
 *
 * Read from the TypeScript AST rather than by importing the module, because the
 * `harness` job in `.github/workflows/scripts-test.yml` runs this suite with NO
 * BUILD STEP — `scripts/` must stay runnable against an unbuilt tree, and
 * `apps/client/vite.config.ts` imports `@dorkos/shared/constants`, whose
 * `exports` map points at a `dist/` that does not exist on a fresh checkout.
 * Importing it would make this guard red on exactly the checkouts where nothing
 * is wrong.
 *
 * Rather than by regex, because a regex cannot tell a `retry:` in a comment from
 * one in code, nor one nested under `coverage:` from the one Vitest reads.
 *
 * The walk starts at `export default`, NOT at "any `defineConfig` call in the
 * file", because only the exported one is the config Vitest loads. Walking the
 * whole file was satisfied by a dead decoy — an unexported `defineConfig({ test:
 * { retry: … } })` sitting above the real export — which is a guard reporting on
 * code that never runs. Every config in the repo is `export default
 * defineConfig({ … })`, so anything else is a shape this function has not been
 * taught to read and it throws rather than returning `undefined`: "no retry" and
 * "I could not find where the retry would be" are different facts, and only the
 * second one is fixed by editing this file.
 *
 * @param configPath - Absolute path of the project's vitest/vite config file.
 */
function retryExpression(configPath: string): string | undefined {
  const source = ts.createSourceFile(
    configPath,
    readFileSync(configPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const shown = path.relative(repoRoot, configPath);

  const exported = source.statements.find(ts.isExportAssignment);
  if (!exported || exported.isExportEquals) {
    throw new Error(`${shown} has no \`export default\` for this guard to read.`);
  }

  const call = exported.expression;
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== 'defineConfig'
  ) {
    throw new Error(`${shown} does not \`export default defineConfig(…)\`.`);
  }

  const configArgument = call.arguments[0];
  if (!configArgument || !ts.isObjectLiteralExpression(configArgument)) {
    throw new Error(`${shown} passes something other than an object literal to defineConfig().`);
  }

  let found: string | undefined;
  for (const topLevel of configArgument.properties) {
    if (
      !ts.isPropertyAssignment(topLevel) ||
      !ts.isIdentifier(topLevel.name) ||
      topLevel.name.text !== 'test' ||
      !ts.isObjectLiteralExpression(topLevel.initializer)
    ) {
      continue;
    }
    for (const testProp of topLevel.initializer.properties) {
      if (
        ts.isPropertyAssignment(testProp) &&
        ts.isIdentifier(testProp.name) &&
        testProp.name.text === 'retry'
      ) {
        found = testProp.initializer.getText(source).replace(/\s+/g, ' ');
      }
    }
  }
  return found;
}

/**
 * The pre-push gate's retry budget has to reach every project, not just the two
 * that happened to wire it.
 *
 * `lefthook.yml` runs the affected-only suite with `VITEST_RETRY=2`, and it
 * passes through turbo's `globalPassThroughEnv` — so the variable is set for
 * every package the gate runs. But a variable nothing reads changes nothing:
 * for most of this repo's life only `apps/server` and `packages/relay` turned it
 * into a `retry`, and the other nineteen projects ran at zero under a gate that
 * believed it had a budget (DOR-1772). A contention flake in any of them —
 * measured live on `@dorkos/client`, red at the gate and 13,982/13,982 green
 * standalone — reddened the push exactly as if the budget had never been set.
 *
 * That failure is the quiet kind. Nothing crashes, nothing warns, and the
 * developer's own re-run usually passes, so the conclusion is "flaky repo"
 * rather than "this package was never given the retries". Forgetting the line
 * in a NEW package is the same mistake with no natural moment of discovery,
 * which is why it fails here instead of being remembered.
 */
describe('VITEST_RETRY reaches every registered project', () => {
  for (const project of rootConfig.test?.projects as string[]) {
    it(`${project} wires the gate's retry budget`, () => {
      expect(retryExpression(configPathFor(project))).toBe(CANONICAL_RETRY);
    });
  }

  it('the pinned expression really yields the budget, and zero without one', async () => {
    // The pin above is textual, so on its own it could pin an expression that
    // does not work. This anchors it to behaviour by executing one config that
    // carries the exact same line. `scripts/vitest.config.ts` on purpose: it is
    // the one config inside `scripts/`, so importing it crosses no workspace
    // boundary and needs no built tree.
    vi.stubEnv('VITEST_RETRY', '3');
    vi.resetModules();
    const withBudget = await import('../vitest.config.ts');
    expect(withBudget.default.test?.retry).toBe(3);

    // `stubEnv(…, undefined)` rather than `unstubAllEnvs()`: this very suite can
    // be running under the pre-push gate, where restoring the ambient
    // environment would restore `VITEST_RETRY=2` and assert nothing.
    vi.stubEnv('VITEST_RETRY', undefined);
    vi.resetModules();
    const withoutBudget = await import('../vitest.config.ts');
    expect(withoutBudget.default.test?.retry).toBe(0);

    vi.unstubAllEnvs();
  });
});
