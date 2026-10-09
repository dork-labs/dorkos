import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import portableConfig from '../../vitest.config.js';
import nativeConfig from '../../vitest.fixture.config.js';
import * as publicApi from '../index.js';
import * as installationApi from '../runtime/installation/index.js';

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
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      found.push(node.argument.literal.text);
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
  it('keeps real acquisition outside default tests and enumerates explicit browser and Node observer fixture files', () => {
    const portable = portableConfig as {
      test: { include: string[]; exclude: string[] };
    };
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
      'darwin-supervisor-browser.fixture.test.ts',
      'darwin-supervisor-engine.fixture.test.ts',
      'default-crash-recovery.fixture.test.ts',
      'lifecycle-exclusion.fixture.test.ts',
      'lifecycle-negative.fixture.test.ts',
      'lifecycle.fixture.test.ts',
      'private-proxy-auth.fixture.test.ts',
      'retained-stores.fixture.test.ts',
      'supervisor-crash-recovery.fixture.test.ts',
    ]);
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    expect(manifest.scripts.build).toBe('tsc -p tsconfig.build.json');
    expect(manifest.scripts['build:native-fixture']).toBe(
      'node --experimental-strip-types scripts/build-native-observer.ts'
    );
    expect(manifest.scripts['test:fixture']).toBe(
      'pnpm build && pnpm build:native-fixture && vitest run --config vitest.fixture.config.ts'
    );
    // Chromium campaigns require their browser preflight; the read-only Node
    // observer campaign has separate explicit helper/worker arms and no Chrome.
    for (const file of actual.filter((name) => name.startsWith('lifecycle')))
      expect(readFileSync(path.join(packageRoot, 'src/__tests__', file), 'utf8')).toContain(
        "import './native-fixture-preflight.js'"
      );
    const observer = readFileSync(
      path.join(packageRoot, 'src/__tests__/default-crash-recovery.fixture.test.ts'),
      'utf8'
    );
    expect(observer).toContain('DORKOS_DARWIN_OBSERVER_FIXTURE');
    expect(observer).toContain('DORKOS_DARWIN_JOURNAL_WORKER_FIXTURE');
    expect(observer).not.toMatch(/from ['"]playwright-core/);
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
    expect(manifest.dependencies).toEqual({
      '@dorkos/shared': 'workspace:*',
      'playwright-core': '1.63.0',
      zod: '^4.6.2',
    });
    const exports = Object.entries(manifest.exports) as [
      string,
      { types: string; default: string },
    ][];
    expect(manifest.exports).toEqual({
      '.': { types: './src/index.ts', default: './dist/index.js' },
      './runtime-installation': {
        types: './src/runtime/installation/index.ts',
        default: './dist/runtime/installation/index.js',
      },
      './server-owner': {
        types: './src/server-owner.ts',
        default: './dist/server-owner.js',
      },
    });
    for (const [subpath, target] of exports) {
      expect(['.', './runtime-installation', './server-owner']).toContain(subpath);
      expect(existsSync(path.resolve(packageRoot, target.types))).toBe(true);
    }
    expect(Object.keys(installationApi).sort()).toEqual(
      [
        'createRuntimeInstallation',
        'resolveInstalledNativeJournal',
        'resolveInstalledRuntimeConfiguration',
        'verifyInstalledNativeJournal',
      ].sort()
    );
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
        const module = path.relative(path.join(packageRoot, 'src'), file).split(path.sep).join('/');
        const allowed: Record<string, readonly string[]> = {
          // Reviewed bounded browser data schemas only; no auth, room, or server capabilities.
          '@dorkos/shared/browser-schemas': ['semantic/owned-read.ts'],
          '@dorkos/shared/browser-semantic-sanitizer': ['semantic/native-reader.ts'],
          '@dorkos/shared/browser-semantic-schemas': [
            'input/semantic-work.ts',
            'runtime/darwin-supervisor-client.ts',
            'runtime/darwin-supervisor-protocol.ts',
            'semantic/native-reader.ts',
            'semantic/native-target.ts',
            'semantic/owned-read.ts',
            'semantic/process-owner.ts',
            'semantic/process-worker.ts',
          ],
          zod: [
            'profiles/storage-state.ts',
            'runtime/darwin-supervisor-protocol.ts',
            'runtime/darwin-supervisor-worker.ts',
            // Private bounded journal records and native supervisor protocol.
            'lifecycle/process-journal.ts',
            'lifecycle/process-reconciliation.ts',
            'runtime/darwin-process-observer.ts',
            'runtime/journal/worker-protocol.ts',
            // Bounded original kernel diagnostic records; no cleanup authority.
            'runtime/darwin-journal-diagnostic.ts',
            'runtime/journal/unknown-diagnostic.ts',
            'runtime/darwin-packaged-observer.ts',
            'configuration.ts',
            'runtime-descriptor.ts',
            'contracts.ts',
            'ids.ts',
            'counters.ts',
            'validation.ts',
            'profiles/reservation.ts',
            'runtime/inspection/records.ts',
            // Private envelope schemas/correlation; no installer backend or SDK imports.
            'runtime/installation-envelope/records.ts',
            'runtime/installation-envelope/correlation.ts',
            'runtime/identity/native-observation.ts',
            'runtime/installation/contracts.ts',
            'runtime/installation/filesystem.ts',
            'semantic/native-effect.ts',
            'semantic/native-reader.ts',
            'semantic/native-target.ts',
            'semantic/owned-read.ts',
            'semantic/process-owner.ts',
            'semantic/process-worker.ts',
          ],
          'node:path': [
            'runtime/identity/supervisor-native-identity.ts',
            // Fixed package-relative native worker and manifest paths.
            'runtime/installation/packaged.ts',
            'runtime/darwin-supervisor-browser.ts',

            'lifecycle/process-journal.ts',
            'runtime-descriptor.ts',
            'runtime/host-identity.ts',
            'runtime/public-library.ts',
            'profiles/paths.ts',
            'profiles/reservation.ts',
            'lifecycle/acquisition.ts',
            'runtime/installation/filesystem.ts',
            'runtime/installation/jobs.ts',
            'runtime/installation/fresh-verifier.ts',
            'runtime/installation/transaction.ts',
          ],
          'node:crypto': [
            'runtime/identity/supervisor-identity-acceptance.ts',
            'runtime/identity/supervisor-native-identity.ts',
            // Package manifest, controller, worker and native artifact hash correspondence.
            'runtime/installation/packaged.ts',
            'runtime/darwin-supervisor-client.ts',

            'lifecycle/acquisition.ts',
            'lifecycle/process-journal.ts',
            'runtime/darwin-process-observer.ts',
            'runtime/darwin-engine-journal.ts',
            'runtime/darwin-packaged-observer.ts',
            'engine.ts',
            'runtime/public-library.ts',
            'runtime/inspection/inspector.ts',
            // Owner-private envelope reference/digest correspondence only.
            'runtime/installation-envelope/correlation.ts',
            'runtime/installation-envelope/domain.ts',
            'profiles/reservation.ts',
            'tabs/registry.ts',
            'runtime/installation/contracts.ts',
            'runtime/installation/filesystem.ts',
            'runtime/installation/jobs.ts',
            'runtime/installation/fresh-verifier.ts',
            'runtime/installation/index.ts',
            // Exact installed native-observer/controller digest correspondence.
            'runtime/installation/native-mode.ts',

            'semantic/bounded-relay.ts',
            'semantic/native-effect.ts',
            'semantic/native-reader.ts',
            'semantic/owned-read.ts',
          ],
          'node:child_process': [
            'runtime/darwin-supervisor-client.ts',

            'runtime/host-identity.ts',
            'runtime/installation/jobs.ts',
            'runtime/darwin-process-observer.ts',
            'runtime/darwin-journal-worker.ts',
            'runtime/darwin-owned-child.ts',

            'semantic/process-owner.ts',
          ],
          'node:fs': [
            'runtime/identity/supervisor-native-identity.ts',
            // No-follow file opens and original file identity comparison.
            'runtime/installation/packaged.ts',
            'runtime/darwin-supervisor-browser.ts',

            'runtime/darwin-packaged-observer.ts',
            'lifecycle/process-journal.ts',
            'runtime/darwin-process-observer.ts',
            'runtime/host-identity.ts',
            'runtime/public-library.ts',
            'profiles/paths.ts',
            'profiles/reservation.ts',
            'profiles/owned-directory.ts',
            'runtime/installation/filesystem.ts',
            'runtime/installation/jobs.ts',
            'runtime/installation/fresh-verifier.ts',
          ],
          'node:fs/promises': [
            'runtime/identity/supervisor-native-identity.ts',
            // Bounded original installed-file reads and canonical package paths.
            'runtime/installation/packaged.ts',
            'runtime/darwin-supervisor-browser.ts',

            'runtime/darwin-packaged-observer.ts',
            'lifecycle/process-journal.ts',
            'runtime/darwin-process-observer.ts',
            'runtime/public-library.ts',
            'lifecycle/acquisition.ts',
            'lifecycle/close.ts',
            'runtime/installation/filesystem.ts',
            'runtime/installation/jobs.ts',
            'runtime/installation/fresh-verifier.ts',
          ],
          'node:stream': [
            'runtime/darwin-supervisor-client.ts',
            'runtime/installation/jobs.ts',
            'runtime/darwin-owned-child.ts',

            'semantic/bounded-relay.ts',
            'semantic/process-owner.ts',
          ],
          'node:url': [
            // Convert the canonical original module URL to its file path.
            'runtime/installation/packaged.ts',
            'runtime/installation/fresh-verifier.ts',
            'runtime/darwin-packaged-observer.ts',
          ],
          // Exact native Proxy rejection for owner-private final binding checks.
          'node:util': [
            'lifecycle/input-owner.ts',
            'runtime/darwin-generation-return.ts',
            'semantic/byte-channel.ts',
          ],
          'node:os': ['runtime/host-identity.ts', 'runtime/identity/supervisor-native-identity.ts'],
          'node:module': [
            // Resolve the installed CLI package relative to its actual controller entry.
            'runtime/installation/packaged.ts',
            'runtime/public-library.ts',
          ],
          // Private identity observers own fixed local peers and the exact original cohort.
          'node:http': [
            'network/fixture-proxy.ts',
            'semantic/bounded-relay.ts',
            'runtime/identity/supervisor-identity-acceptance.ts',
            'runtime/identity/supervisor-native-identity.ts',
          ],
          'node:tls': ['runtime/identity/supervisor-identity-acceptance.ts'],
          'node:perf_hooks': [
            'runtime/identity/supervisor-native-cohort.ts',
            // Observation-only elapsed selection phases use the monotonic clock.
            'input/selection-phase.ts',
            'runtime/installation/phase-diagnostic.ts',
          ],
          // Only pinned public types/library imports in these reviewed internal modules.
          // Inline import types are enumerated too; private package subpaths stay forbidden.
          'playwright-core': [
            // Public transport type for the same original SDK controller auth owner.
            'runtime/identity/controller-proxy-authentication.ts',
            'runtime/identity/controller-original-catalog.ts',
            'runtime/identity/supervisor-native-identity.ts',
            'runtime/identity/supervisor-original-catalog.ts',
            'runtime/identity/supervisor-protocol-wire.ts',
            'runtime/identity/supervisor-proxy-authentication.ts',
            'runtime/identity/supervisor-sdk-reconciliation.ts',
            // Public original transport type for the retained private Chrome bridge.
            'runtime/identity/supervisor-chrome-barrier.ts',
            'runtime/crash-custody.ts',
            // Public Browser/CDPSession types pin the sole lifetime-retained deny owner.
            'runtime/default-downloads.ts',
            // Exact public Request/Route/Frame/CDPSession types for private canonical navigation.
            'navigation/navigate.ts',
            'navigation/owner-continuation.ts',
            'navigation/owner-same-document.ts',
            'navigation/native-same-document.ts',
            // Public Request identity for the private one-shot navigation owner.
            'lifecycle/initial-navigation.ts',
            'runtime/darwin-supervisor-worker.ts',
            'runtime/darwin-supervisor-browser.ts',

            'tabs/diagnostics.ts',
            'runtime/public-library.ts',
            'lifecycle/records.ts',
            'lifecycle/ownership.ts',
            'lifecycle/acquisition.ts',
            'tabs/registry.ts',
            // Public Page/context types pin original popup viewport and navigation ownership.
            'tabs/popup-navigation.ts',
            'input/page-transport.ts',
            // Fixed owner-only root-selection inspection on the existing original input session.
            'input/selection-copy.ts',
            'input/engine-input.ts',

            'files/response-download.ts',
            'files/upload-chooser.ts',
            'runtime/target-metadata.ts',
            'semantic/native-effect.ts',
            'semantic/native-reader.ts',
            'semantic/process-worker.ts',
          ],
          'node:net': [
            'semantic/bounded-relay.ts',
            'semantic/process-worker.ts',
            'runtime/identity/supervisor-identity-acceptance.ts',
            'runtime/identity/supervisor-native-identity.ts',
          ],
          'node:v8': ['semantic/process-worker.ts'],
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
    const tuples = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    }).map((specifier) => ({
      file: path.join(repoRoot, root, 'package.json'),
      specifier,
    }));
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
        tuples.push(
          ...importsFromText(file, text).map((specifier) => ({
            file,
            specifier,
          }))
        );
        oldTuples.push(
          ...importsFromText(file, text, true).map((specifier) => ({
            file,
            specifier,
          }))
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
