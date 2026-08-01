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
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
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
