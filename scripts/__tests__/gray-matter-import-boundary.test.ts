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

/** Detect static, dynamic, re-export, and CommonJS imports of gray-matter. */
function importsGrayMatter(source: string): boolean {
  const packageName = ['gray', 'matter'].join('-');
  return new RegExp(String.raw`(?:from\s*|import\s*\(|require\s*\()\s*['"]${packageName}['"]`).test(
    source
  );
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
    expect(importsGrayMatter(`// see ${name} docs`)).toBe(false);
  });
});
