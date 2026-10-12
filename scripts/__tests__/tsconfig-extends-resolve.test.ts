/**
 * Every tracked tsconfig's `extends` resolves, the way `tsc` resolves it (DOR-2089).
 *
 * When a base config cannot be found, `tsc` reports `Cannot find base config file`
 * and carries on with its own defaults (ES5, not strict), so a package can be
 * type-checked under different rules than it declares while its typecheck stays
 * green. `packages/cloud-api` did exactly that under the credential-free scrub when
 * it arrived. This asks TypeScript itself to read each config's chain, without
 * listing any source files, and fails on a base it cannot find.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/** TS6053 "File not found" and TS5083 "Cannot read file": what an unresolved base reports. */
const MISSING_BASE_CODES = new Set([6053, 5083]);

/** Every tracked tsconfig, from `git ls-files` so no `node_modules` copy is read. */
function trackedTsconfigs(): string[] {
  return execFileSync('git', ['ls-files', '--', '*tsconfig*.json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

/** The errors TypeScript raises while following `file`'s `extends` chain. */
function missingBases(file: string): string[] {
  const absolute = path.join(repoRoot, file);
  const read = ts.readConfigFile(absolute, ts.sys.readFile);
  if (read.error) return [ts.flattenDiagnosticMessageText(read.error.messageText, '\n')];
  // No directory listing: only the extends chain matters here, not the file set.
  const host = { ...ts.sys, readDirectory: () => [] };
  const parsed = ts.parseJsonConfigFileContent(read.config, host, path.dirname(absolute));
  return parsed.errors
    .filter((error) => MISSING_BASE_CODES.has(error.code))
    .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'));
}

describe('tsconfig base configs', () => {
  it('finds a reasonable number of tsconfigs', () => {
    // Guards the guard: an empty list (wrong cwd, no git) would pass below.
    expect(trackedTsconfigs().length).toBeGreaterThan(30);
  });

  it('resolves every extends chain', () => {
    const broken = trackedTsconfigs().flatMap((file) =>
      missingBases(file).map((message) => `${file}: ${message}`)
    );
    expect(broken).toEqual([]);
  });
});
