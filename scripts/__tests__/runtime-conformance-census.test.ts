import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every runtime folder runs the shared conformance suite (DOR-4940).
 *
 * `.claude/rules/server-structure.md` says each adapter under
 * `apps/server/src/services/runtimes/<runtime>/` must pass `runtimeConformance`
 * from `@dorkos/test-utils`. A sentence cannot notice a runtime that never
 * did: computer-local ran without the suite until DOR-4902. So each folder
 * there is either a runtime, held to a `__tests__/conformance.test.ts` that
 * imports and calls `runtimeConformance`, or named below as not a runtime.
 *
 * A new folder fails here until someone decides which it is. A runtime that
 * lives inside another runtime's folder is listed in {@link NESTED_RUNTIMES}.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const RUNTIMES_DIR = 'apps/server/src/services/runtimes';

/** Folders under `runtimes/` that hold no runtime of their own, with why. */
const NOT_RUNTIMES: Record<string, string> = {
  __tests__: 'cross-runtime tests',
  shared: 'helpers every runtime uses',
  connect: 'sign-in and credential flows for the runtimes',
  'connector-mcp': 'the MCP server that hands connector tools to a running turn',
  connectors: "the lease and turn opener for a connection's turns",
  'context-preview': 'the preview of the instructions a runtime would send',
};

/** Runtimes that live in a subfolder of another runtime's folder. */
const NESTED_RUNTIMES: Record<string, string> = {
  'opencode/computer': 'computer-local, OpenCode inside an agent computer (DOR-4902)',
};

const IMPORTS_SUITE =
  /import\s*\{[^}]*\bruntimeConformance\b[^}]*\}\s*from\s*['"]@dorkos\/test-utils['"]/;
const CALLS_SUITE = /\bruntimeConformance\s*\(/;

function topLevelFolders(): string[] {
  return readdirSync(path.join(ROOT, RUNTIMES_DIR), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Why a runtime folder fails the rule, or null when it passes. */
function conformanceProblem(folder: string): string | null {
  const file = path.join(ROOT, RUNTIMES_DIR, folder, '__tests__/conformance.test.ts');
  if (!existsSync(file)) return 'has no __tests__/conformance.test.ts';
  const source = readFileSync(file, 'utf8');
  if (!IMPORTS_SUITE.test(source)) return 'does not import runtimeConformance';
  if (!CALLS_SUITE.test(source)) return 'never calls runtimeConformance';
  return null;
}

describe('the runtime conformance census', () => {
  const folders = topLevelFolders();
  const runtimes = [
    ...folders.filter((name) => !(name in NOT_RUNTIMES)),
    ...Object.keys(NESTED_RUNTIMES),
  ];

  it('found the runtimes, so it cannot pass on nothing', () => {
    // claude-code, codex, doe, opencode, test-mode and computer-local when written.
    expect(runtimes.length).toBeGreaterThanOrEqual(6);
  });

  it('every runtime folder runs the shared conformance suite', () => {
    const failing = runtimes.flatMap((folder) => {
      const problem = conformanceProblem(folder);
      return problem ? [`${RUNTIMES_DIR}/${folder} ${problem}`] : [];
    });
    expect(
      failing,
      'Give each runtime a __tests__/conformance.test.ts that calls runtimeConformance, ' +
        'or, if the folder is not a runtime, add it to NOT_RUNTIMES with the reason.'
    ).toEqual([]);
  });

  it('every listed exception is a real folder, so the lists cannot go stale', () => {
    const stale = [...Object.keys(NOT_RUNTIMES), ...Object.keys(NESTED_RUNTIMES)].filter(
      (folder) => !existsSync(path.join(ROOT, RUNTIMES_DIR, folder))
    );
    expect(stale, 'Remove these entries: the folders are gone.').toEqual([]);
  });
});
