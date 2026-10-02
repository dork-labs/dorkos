import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import portableConfig from '../../vitest.config.js';
import nativeConfig from '../../vitest.fixture.config.js';
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
  it('keeps real acquisition outside default tests and includes all three explicit fixture files', () => {
    const portable = portableConfig as { test: { include: string[]; exclude: string[] } };
    const native = nativeConfig as {
      test: { include: string[]; fileParallelism: boolean; retry: number };
    };
    expect(portable.test.include).toEqual(['src/**/__tests__/**/*.test.ts']);
    expect(portable.test.exclude).toContain('src/**/__tests__/**/*.fixture.test.ts');
    expect(native.test.include).toEqual(['src/**/__tests__/**/*.fixture.test.ts']);
    expect(native.test.fileParallelism).toBe(false);
    expect(native.test.retry).toBe(0);
    const actual = readdirSync(path.join(packageRoot, 'src/__tests__'))
      .filter((name) => name.endsWith('.fixture.test.ts'))
      .sort();
    expect(actual).toEqual([
      'lifecycle-exclusion.fixture.test.ts',
      'lifecycle-negative.fixture.test.ts',
      'lifecycle.fixture.test.ts',
    ]);
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    expect(manifest.scripts['test:fixture']).toBe(
      'pnpm build && vitest run --config vitest.fixture.config.ts'
    );
    for (const file of actual)
      expect(readFileSync(path.join(packageRoot, 'src/__tests__', file), 'utf8')).toContain(
        "import './native-fixture-preflight.js'"
      );
  });

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
  it('exports implemented validation and the complete narrow lifecycle slice through the real package entry', () => {
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
        'BrowserLifecycleError',
        'createBrowserEngine',
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
      else {
        const module = path.relative(path.join(packageRoot, 'src'), file);
        const allowed: Record<string, readonly string[]> = {
          zod: [
            'configuration.ts',
            'runtime-descriptor.ts',
            'contracts.ts',
            'ids.ts',
            'counters.ts',
            'validation.ts',
            'profiles/reservation.ts',
          ],
          'node:path': [
            'runtime-descriptor.ts',
            'runtime/host-identity.ts',
            'runtime/public-library.ts',
            'profiles/paths.ts',
            'profiles/reservation.ts',
            'lifecycle/acquisition.ts',
          ],
          'node:crypto': [
            'engine.ts',
            'runtime/public-library.ts',
            'profiles/reservation.ts',
            'tabs/registry.ts',
          ],
          'node:child_process': ['runtime/host-identity.ts'],
          'node:fs': [
            'runtime/host-identity.ts',
            'runtime/public-library.ts',
            'profiles/paths.ts',
            'profiles/reservation.ts',
            'profiles/owned-directory.ts',
          ],
          'node:fs/promises': [
            'runtime/public-library.ts',
            'lifecycle/acquisition.ts',
            'lifecycle/close.ts',
          ],
          'node:os': ['runtime/host-identity.ts'],
          'node:module': ['runtime/public-library.ts'],
          'node:http': ['network/fixture-proxy.ts'],
          'playwright-core': [
            'runtime/public-library.ts',
            'lifecycle/records.ts',
            'tabs/registry.ts',
          ],
        };
        expect(allowed[specifier], `${module}: ${specifier}`).toContain(module);
      }
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
