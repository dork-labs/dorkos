/**
 * The dependency budget (plan §4.1): the engine imports only Node built-ins,
 * `zod`, `yaml`, and its own files. Nothing from the rest of the monorepo, so
 * the package can move to a marketplace plugin unchanged, and everything
 * repo-specific has to come from `ci/config.yaml`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const pkgDir = path.resolve(import.meta.dirname, '..', '..');
const srcDir = path.join(pkgDir, 'src');
const ALLOWED_PACKAGES = new Set(['zod', 'yaml']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(path.join(dir, e.name));
    return e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [];
  });
}

function specifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
    out.push(m[1]!);
  }
  for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!);
  for (const m of text.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) out.push(m[1]!);
  return out;
}

describe('dependency budget', () => {
  const files = sourceFiles(srcDir);

  it('finds the engine sources to check', () => {
    expect(files.map((f) => path.basename(f))).toContain('census.ts');
  });

  for (const file of files) {
    it(`${path.relative(pkgDir, file)} imports only built-ins, zod, yaml and relative files`, () => {
      const bad = specifiers(readFileSync(file, 'utf8')).filter((s) => {
        if (s.startsWith('./') || s.startsWith('../')) return false;
        if (s.startsWith('node:')) return !builtinModules.includes(s.slice(5));
        return !ALLOWED_PACKAGES.has(s);
      });
      expect(bad).toEqual([]);
    });

    it(`${path.relative(pkgDir, file)} imports relative files with their .ts extension, inside src`, () => {
      for (const s of specifiers(readFileSync(file, 'utf8'))) {
        if (!s.startsWith('.')) continue;
        expect(s.endsWith('.ts')).toBe(true);
        expect(path.resolve(path.dirname(file), s).startsWith(srcDir)).toBe(true);
      }
    });
  }

  it('declares only zod and yaml as runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(['yaml', 'zod']);
  });
});
