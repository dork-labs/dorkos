import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// A whole-repo scan, sized like its sibling composio-sdk-import-boundary.test.ts
// (see that file for how the 15s budget was measured).
vi.setConfig({ testTimeout: 15_000 });

/**
 * The one file allowed to import gray-matter. gray-matter `eval`s any
 * frontmatter block that opens with `---js`, so reading a package's markdown
 * with it directly let the package run code in the server (DOR-2308). The
 * wrapper refuses those blocks; everything else, tests included, goes through
 * it. There is no test allowlist on purpose: a test that parses fixtures with
 * raw gray-matter teaches the next reader that raw gray-matter is fine.
 *
 * ESLint enforces the same boundary in the packages that can resolve the
 * dependency (apps/server, packages/skills); this scan covers every other file,
 * including packages that could add the dependency later.
 */
const GRAY_MATTER_OWNER = 'packages/skills/src/frontmatter.ts';

/**
 * Detect every import spelling of gray-matter or any path inside it: static,
 * side-effect, dynamic, re-export and CommonJS, with a quoted or
 * template-literal specifier.
 */
function importsGrayMatter(source: string): boolean {
  const packageName = ['gray', 'matter'].join('-');
  return new RegExp(
    String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"\x60])${packageName}(?:/[^'"\x60]*)?\1`
  ).test(source);
}

describe('gray-matter import boundary (DOR-2308)', () => {
  it('confines every repository import to the safe frontmatter wrapper', () => {
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
    expect(files).toContain(GRAY_MATTER_OWNER);

    const importers = files.filter((path) => importsGrayMatter(readFileSync(path, 'utf8')));
    expect(importers).toEqual([GRAY_MATTER_OWNER]);
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
    // Mentions that are not imports, and look-alike packages, do not match.
    expect(importsGrayMatter(`// see ${name} docs`)).toBe(false);
    expect(importsGrayMatter(`import x from '${name}-extra';`)).toBe(false);
    expect(importsGrayMatter(`const externals = ['${name}'];`)).toBe(false);
  });
});
