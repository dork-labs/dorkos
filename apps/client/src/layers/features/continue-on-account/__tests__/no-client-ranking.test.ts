/**
 * Invariant 6 (spec `claude-account-ui` §4): the UI never decides what the
 * server decides. The server ranks the accounts a limited session can carry
 * over to; this slice only displays that order. So no file here may import a
 * ranking function or sort the server's list.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SLICE = join(__dirname, '..');

/** Every non-test source file under the slice. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Each import's specifier and the names it brings in. */
function imports(source: string): { specifier: string; names: string }[] {
  const found: { specifier: string; names: string }[] = [];
  const pattern =
    /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    found.push({ names: match[1] ?? '', specifier: match[2] ?? match[3] ?? '' });
  }
  return found;
}

/** What a file does wrong under invariant 6, if anything. */
function rankingViolations(source: string): string[] {
  const problems: string[] = [];
  for (const { specifier, names } of imports(source)) {
    if (/rank/i.test(specifier)) problems.push(`imports from ${specifier}`);
    if (/rank/i.test(names)) problems.push(`imports ${names.trim()}`);
  }
  // `.sort(` on the server's list, reached through `ranking`, `accounts` or a copy of either.
  if (
    /(ranking|accounts|rows|same|other)\s*(\?\.|\.)\s*(slice\(\)\s*\.\s*)?(sort|toSorted)\s*\(/.test(
      source
    )
  ) {
    problems.push('sorts the ranking');
  }
  return problems;
}

describe('invariant 6: the picker never ranks accounts itself', () => {
  const files = sourceFiles(SLICE);

  it('finds the slice source files', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it.each(files.map((file) => [relative(SLICE, file), file]))(
    '%s imports no ranking function and sorts nothing',
    (_name, file) => {
      expect(rankingViolations(readFileSync(file, 'utf8'))).toEqual([]);
    }
  );

  it('catches a ranking import and a sort (the check can fail)', () => {
    expect(
      rankingViolations("import { rankAccounts } from '@dorkos/shared/account-rank';")
    ).toEqual(['imports from @dorkos/shared/account-rank', 'imports { rankAccounts }']);
    expect(rankingViolations('const x = data.ranking.accounts.sort((a, b) => 0);')).toEqual([
      'sorts the ranking',
    ]);
  });
});
