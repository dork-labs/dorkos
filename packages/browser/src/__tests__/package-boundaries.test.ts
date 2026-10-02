import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as publicApi from '../index.js';

const packageRoot = path.resolve(import.meta.dirname, '../..');
const repoRoot = path.resolve(packageRoot, '../..');

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(fullPath);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [fullPath] : [];
  });
}

function imports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const found: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      found.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) found.push(argument.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

describe('private browser package boundaries', () => {
  it('resolves the public pinned production library and its real relative assets without acquisition', () => {
    const require = createRequire(path.join(packageRoot, 'package.json'));
    const metadataPath = require.resolve('playwright-core/package.json');
    const library = JSON.parse(readFileSync(metadataPath, 'utf8'));
    expect(library.name).toBe('playwright-core');
    expect(library.version).toBe('1.63.0');
    const libraryRoot = path.dirname(metadataPath);
    const assets = ['browsers.json', 'cli.js'];
    expect(assets).toHaveLength(2);
    for (const asset of assets) expect(existsSync(path.join(libraryRoot, asset))).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(libraryRoot, 'browsers.json'), 'utf8'));
    const chromium = manifest.browsers.filter(
      (browser: { name: string }) => browser.name === 'chromium'
    );
    expect(chromium).toHaveLength(1);
    expect(chromium[0].revision).toBe('1243');
  });
  it('exports only implemented validation operations through the real package entry', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies).toEqual({ 'playwright-core': '1.63.0', zod: '^4.6.2' });
    const exports = Object.entries(manifest.exports) as [
      string,
      { types: string; default: string },
    ][];
    expect(exports).toHaveLength(1);
    for (const [subpath, target] of exports) {
      expect(subpath).toBe('.');
      expect(existsSync(path.resolve(packageRoot, target.types))).toBe(true);
      expect(target.default).toBe('./dist/index.js');
    }
    expect(Object.keys(publicApi).sort()).toEqual(
      [
        'BrowserValidationError',
        'advanceCounter',
        'parseBrowserCommand',
        'parseBrowserId',
        'parseBrowserResult',
        'parseProfileId',
        'parseRuntimeDescriptor',
        'parseTabId',
        'validateEngineConfiguration',
      ].sort()
    );
  });

  it('enumerates engine source imports and excludes apps, auth/room contracts and runtime SDKs', () => {
    const files = sourceFiles(path.join(packageRoot, 'src'));
    expect(files.length).toBeGreaterThan(0);
    const resolvedImports = files.flatMap((file) =>
      imports(file).map((specifier) => ({ file, specifier }))
    );
    expect(resolvedImports.length).toBeGreaterThan(0);
    for (const { file, specifier } of resolvedImports) {
      if (specifier.startsWith('.'))
        expect(path.resolve(path.dirname(file), specifier).startsWith(packageRoot + path.sep)).toBe(
          true
        );
      else expect(['zod', 'node:path']).toContain(specifier);
    }
  });

  it('keeps the engine and its browser library outside all existing frontend imports', () => {
    const roots = ['apps/client', 'packages/ui'];
    let examined = 0;
    for (const root of roots) {
      const dir = path.join(repoRoot, root);
      const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
        expect(name).not.toMatch(/^(?:@dorkos\/browser|playwright-core)$/);
      }
      const files = sourceFiles(path.join(dir, 'src'));
      expect(files.length).toBeGreaterThan(0);
      examined += files.length;
      for (const file of files) {
        for (const specifier of imports(file)) {
          expect(specifier).not.toMatch(/^(?:@dorkos\/browser|playwright-core)(?:\/|$)/);
          if (specifier.startsWith('.'))
            expect(
              path.resolve(path.dirname(file), specifier).startsWith(packageRoot + path.sep)
            ).toBe(false);
        }
      }
    }
    expect(examined).toBeGreaterThan(0);
  });
});
