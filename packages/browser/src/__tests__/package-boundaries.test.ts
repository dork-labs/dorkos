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

function importsFromText(file: string, text: string, parentNodes = false): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, parentNodes);
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

function imports(file: string): string[] {
  return importsFromText(file, readFileSync(file, 'utf8'));
}

type ImportTuple = { file: string; specifier: string };
const frontendRoots = ['apps/client', 'packages/ui'] as const;
const frontendFiles = frontendRoots.map((root) => ({
  root,
  files: sourceFiles(path.join(repoRoot, root, 'src')).sort(),
}));
function batches(files: readonly string[]): string[][] {
  const result: string[][] = [];
  for (let offset = 0; offset < files.length; offset += 64)
    result.push(files.slice(offset, offset + 64));
  return result;
}
function completePartition(
  files: readonly string[],
  parts: readonly (readonly string[])[]
): boolean {
  const flat = parts.flat();
  const expected = [...files].sort();
  return (
    files.length > 0 &&
    new Set(files).size === files.length &&
    flat.length === files.length &&
    new Set(flat).size === flat.length &&
    [...flat].sort().every((file, index) => file === expected[index])
  );
}
function frontendViolations(tuples: readonly ImportTuple[]): ImportTuple[] {
  return tuples.filter(
    ({ file, specifier }) =>
      /^(?:@dorkos\/browser|playwright-core)(?:\/|$)/.test(specifier) ||
      (specifier.startsWith('.') &&
        path.resolve(path.dirname(file), specifier).startsWith(packageRoot + path.sep))
  );
}
const frontendBatches = frontendFiles.flatMap(({ root, files }) =>
  batches(files).map((files, index) => ({ root, index, files }))
);
const importCounts = new Map<string, number>();
const byteCounts = new Map<string, number>();

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
            'runtime/inspection/records.ts',
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
            'runtime/inspection/inspector.ts',
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

  it('partitions every discovered frontend file exactly once across both roots', () => {
    for (const { root, files } of frontendFiles)
      expect(
        completePartition(
          files,
          frontendBatches.filter((batch) => batch.root === root).map((batch) => batch.files)
        )
      ).toBe(true);
    expect(frontendFiles.map(({ root }) => root)).toEqual([...frontendRoots]);
  });
  it.each(frontendRoots)('keeps %s dependencies outside the browser package', (root) => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, root, 'package.json'), 'utf8'));
    const tuples = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).map(
      (specifier) => ({ file: path.join(repoRoot, root, 'package.json'), specifier })
    );
    expect(frontendViolations(tuples)).toEqual([]);
  });
  it.each(frontendBatches)(
    'checks all frontend imports in $root batch $index',
    ({ root, files }) => {
      const tuples: ImportTuple[] = [];
      const oldTuples: ImportTuple[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        byteCounts.set(root, (byteCounts.get(root) ?? 0) + Buffer.byteLength(text));
        tuples.push(...importsFromText(file, text).map((specifier) => ({ file, specifier })));
        oldTuples.push(
          ...importsFromText(file, text, true).map((specifier) => ({ file, specifier }))
        );
      }
      expect(tuples).toEqual(oldTuples);
      expect(frontendViolations(tuples)).toEqual([]);
      importCounts.set(root, (importCounts.get(root) ?? 0) + tuples.length);
    }
  );
  it('observes nonzero complete import subjects in both frontend roots', () => {
    for (const root of frontendRoots) expect(importCounts.get(root)).toBeGreaterThan(0);
    console.info(
      'frontend import census',
      JSON.stringify(
        frontendFiles.map(({ root, files }) => ({
          root,
          files: files.length,
          bytes: byteCounts.get(root),
          imports: importCounts.get(root),
          batches: frontendBatches.filter((batch) => batch.root === root).length,
        }))
      )
    );
  });
  it.each([
    [
      'imports.ts',
      "import 'side'; import x from 'default'; import {x as y} from 'named'; import type {T} from 'type';",
      ['side', 'default', 'named', 'type'],
    ],
    [
      'exports.ts',
      "export {x} from 'export'; export * from 'star'; export * as hidden from 'namespace';",
      ['export', 'star', 'namespace'],
    ],
    [
      'nested.ts',
      "function f(){ require('nested'); return import('dynamic'); }",
      ['nested', 'dynamic'],
    ],
    [
      'template.ts',
      "const x = `${require('playwright-core')}`; const y = require(`ignored`);",
      ['playwright-core'],
    ],
    [
      'view.tsx',
      "const x = <div>{require('jsx')}</div>; import 'escaped\\u002dmodule';",
      ['jsx', 'escaped-module'],
    ],
    [
      'decoys.ts',
      "// import 'comment';\nconst x = \"require('string')\"; other.require('member'); require(variable); import(variable);",
      [],
    ],
  ] as const)('preserves literal AST grammar for %s', (file, text, expected) => {
    expect(importsFromText(file, text)).toEqual(expected);
    expect(importsFromText(file, text, true)).toEqual(expected);
  });
  it.each(['first', 'middle', 'last', 'client', 'ui'])(
    'detects forbidden imports at %s',
    (position) => {
      const index =
        position === 'last'
          ? frontendBatches.length - 1
          : position === 'middle'
            ? Math.floor(frontendBatches.length / 2)
            : position === 'ui'
              ? frontendBatches.findIndex(({ root }) => root === 'packages/ui')
              : 0;
      const file = frontendBatches[index]!.files[0]!;
      const tuples = [
        { file, specifier: 'safe' },
        { file, specifier: 'playwright-core' },
        { file, specifier: '@dorkos/browser/private' },
      ];
      expect(frontendViolations(tuples)).toEqual(tuples.slice(1));
      expect(
        frontendViolations([
          {
            file,
            specifier: path.relative(path.dirname(file), path.join(packageRoot, 'src/index.ts')),
          },
        ])
      ).toHaveLength(1);
    }
  );
  it('rejects omitted and duplicate partition members', () => {
    const files = ['a', 'b', 'c'];
    expect(completePartition(files, [['a'], ['b', 'c']])).toBe(true);
    expect(completePartition(files, [['a'], ['b']])).toBe(false);
    expect(completePartition(files, [['a'], ['b', 'b', 'c']])).toBe(false);
    expect(completePartition(files, [['a'], ['b', 'b']])).toBe(false);
    expect(completePartition([], [])).toBe(false);
  });
});
