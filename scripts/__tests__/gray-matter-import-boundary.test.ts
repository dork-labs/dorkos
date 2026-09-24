import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// A whole-repo scan, sized like its sibling composio-sdk-import-boundary.test.ts
// (see that file for how the 15s budget was measured).
vi.setConfig({ testTimeout: 15_000 });

/**
 * gray-matter is not used anywhere in the repo, and must not come back. It
 * `eval`s any frontmatter block that opens with `---js` (DOR-2308), and before
 * any parser runs it strips comments with a regular expression that is
 * quadratic in the block's length (DOR-2311). `@dorkos/skills/frontmatter`
 * reads frontmatter itself instead. No file is allowed, tests included: a test
 * that parses fixtures with raw gray-matter teaches the next reader that raw
 * gray-matter is fine.
 *
 * ESLint bans the same import in apps/server and packages/skills; this scan
 * covers every other file, including packages that could add the dependency
 * later.
 */

/**
 * Detect every load of gray-matter or any path inside it, however it is
 * written: `import ... from` or a bare `import '...'`, or the name as the first
 * argument of any call, which covers `require(...)`, `import(...)`,
 * `createRequire(...)(...)` and `require.resolve(...)`. Any quote style,
 * template literals included.
 */
function importsGrayMatter(source: string): boolean {
  const packageName = ['gray', 'matter'].join('-');
  return new RegExp(
    String.raw`(?:\b(?:from|import)\s*|\(\s*)(['"\x60])${packageName}(?:/[^'"\x60]*)?\1`
  ).test(source);
}

describe('gray-matter import boundary (DOR-2308, DOR-2311)', () => {
  it('finds no import of gray-matter anywhere in the repository', () => {
    const files = execFileSync(
      'git',
      [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        '*.ts',
        '*.tsx',
        '*.js',
        '*.mjs',
        '*.cjs',
        '*.mts',
        '*.cts',
      ],
      { encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .filter((path) => path.length > 0 && existsSync(path));
    expect(files.length).toBeGreaterThan(100);

    const importers = files.filter((path) => importsGrayMatter(readFileSync(path, 'utf8')));
    expect(importers).toEqual([]);
  });

  it('recognises each import spelling the scan must catch', () => {
    // Purpose: prove the matcher can fail, so an empty violation list means
    // something. The package name is split so this file does not match itself.
    const name = ['gray', 'matter'].join('-');
    expect(importsGrayMatter(`import matter from '${name}';`)).toBe(true);
    expect(importsGrayMatter(`const m = await import("${name}");`)).toBe(true);
    expect(importsGrayMatter(`const m = require('${name}');`)).toBe(true);
    expect(importsGrayMatter(`export { default } from '${name}';`)).toBe(true);
    expect(importsGrayMatter(`import '${name}';`)).toBe(true);
    // Deep paths reach the eval engine just as well as the package root.
    expect(importsGrayMatter(`const e = await import('${name}/lib/engines.js');`)).toBe(true);
    expect(importsGrayMatter(`const e = require("${name}/lib/engines");`)).toBe(true);
    // A template-literal specifier is still a static string.
    expect(importsGrayMatter('const m = require(`' + name + '`);')).toBe(true);
    expect(importsGrayMatter('const m = await import(`' + name + '/lib/parse.js`);')).toBe(true);
    // Indirect loaders pass the name as a call's first argument.
    expect(importsGrayMatter(`const m = createRequire(import.meta.url)('${name}');`)).toBe(true);
    expect(importsGrayMatter(`const where = require.resolve('${name}');`)).toBe(true);
    // Mentions that are not imports, and look-alike packages, do not match.
    expect(importsGrayMatter(`// see ${name} docs`)).toBe(false);
    expect(importsGrayMatter(`import x from '${name}-extra';`)).toBe(false);
    expect(importsGrayMatter(`const externals = ['${name}'];`)).toBe(false);
  });
});
