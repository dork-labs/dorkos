import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import {
  browserProductionSubject,
  browserProductionInputs,
  BROWSER_SUBJECT_ROOTS,
  BROWSER_SUBJECT_ENTRIES,
  BROWSER_SUBJECT_WIRING,
} from '../browser-production-subject.js';

const catalogue = 'apps/server/src/services/browser/runtime/admission/accepted-catalogue.ts';
const catalogueSource = (records: string) =>
  "import type { AcceptedBrowserMode } from './accepted-mode.js';\nexport const acceptedBrowserModes: readonly AcceptedBrowserMode[] = Object.freeze(" +
  records +
  ');';
async function sourceTree() {
  const root = await mkdtemp(join(tmpdir(), 'browser-subject-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await write('packages/db/drizzle/meta/_journal.json', '{}');
  await write(catalogue, catalogueSource('[]'));
  for (const path of BROWSER_SUBJECT_ROOTS) await mkdir(join(root, path), { recursive: true });
  for (const path of [...BROWSER_SUBJECT_ENTRIES, ...BROWSER_SUBJECT_WIRING]) await write(path, '');
  for (const [dir, name] of [
    ['apps/server', '@dorkos/server'],
    ['apps/client', '@dorkos/client'],
    ['apps/desktop', '@dorkos/desktop'],
    ['packages/cli', 'dorkos'],
    ['packages/browser', '@dorkos/browser'],
    ['packages/shared', '@dorkos/shared'],
  ])
    await write(
      dir + '/package.json',
      JSON.stringify({
        name,
        exports: {
          './browser-schemas': {
            types: './src/browser-schemas.ts',
            default: './dist/browser-schemas.js',
          },
        },
      })
    );
  const names = [
    'playwright-core',
    'typescript',
    'yaml',
    'electron',
    'electron-builder',
    'esbuild',
  ];
  const row = (name: string) => [name, { specifier: '1.0.0', version: '1.0.0' }];
  await write(
    'pnpm-lock.yaml',
    JSON.stringify({
      importers: {
        '.': { devDependencies: Object.fromEntries([row('typescript')]) },
        'packages/browser': { dependencies: Object.fromEntries([row('playwright-core')]) },
        'apps/desktop': {
          devDependencies: Object.fromEntries(['yaml', 'electron', 'electron-builder'].map(row)),
        },
        'packages/cli': { devDependencies: Object.fromEntries([row('esbuild')]) },
      },
      packages: Object.fromEntries(
        names.map((name) => [name + '@1.0.0', { resolution: { integrity: 'original-' + name } }])
      ),
      snapshots: Object.fromEntries(names.map((name) => [name + '@1.0.0', {}])),
    })
  );
  await write('apps/server/src/services/browser/egress/policy.ts', 'export const revision = 1;');
  return { root, write };
}
it('invalidates the actual browser policy but preserves unrelated source and catalogue publication', async () => {
  const f = await sourceTree(),
    original = await browserProductionSubject(f.root);
  await f.write('packages/ci-steward/src/judge.ts', 'export const unrelated = 1;');
  await f.write(
    'apps/server/src/services/runtimes/codex/unrelated.ts',
    'export const unrelated = 2;'
  );
  await f.write(
    'apps/server/src/services/browser/runtime/admission/accepted-catalogue.ts',
    catalogueSource('[{ reviewed: true, receipts: [null, false, 17, -1, "original"] }]')
  );
  expect(await browserProductionSubject(f.root)).toBe(original);
  await f.write('apps/server/src/services/browser/egress/policy.ts', 'export const revision = 2;');
  expect(await browserProductionSubject(f.root)).not.toBe(original);
});
it('follows a real transitive runtime dependency and only requested barrel exports', async () => {
  const f = await sourceTree();
  await f.write(
    'apps/server/src/services/browser/egress/policy.ts',
    "import { original } from '../../core/selected.js'; export const policy = original;"
  );
  await f.write(
    'apps/server/src/services/core/selected.ts',
    "export { original } from './owned.js'; export { unrelated } from './other-domain.js';"
  );
  await f.write('apps/server/src/services/core/owned.ts', 'export const original = 1;');
  await f.write('apps/server/src/services/core/other-domain.ts', 'export const unrelated = 1;');
  const inputs = await browserProductionInputs(f.root),
    original = await browserProductionSubject(f.root);
  expect(inputs.has('apps/server/src/services/core/owned.ts')).toBe(true);
  expect(inputs.has('apps/server/src/services/core/other-domain.ts')).toBe(false);
  await f.write('apps/server/src/services/core/other-domain.ts', 'export const unrelated = 2;');
  expect(await browserProductionSubject(f.root)).toBe(original);
  await f.write('apps/server/src/services/core/owned.ts', 'export const original = 2;');
  expect(await browserProductionSubject(f.root)).not.toBe(original);
});
it('refuses an unresolved original import rather than silently omitting it', async () => {
  const f = await sourceTree();
  await f.write('apps/server/src/services/browser/egress/policy.ts', "import './missing.js';");
  await expect(browserProductionSubject(f.root)).rejects.toThrow(
    'BROWSER_SUBJECT_SOURCE_UNAVAILABLE'
  );
});
it('binds selected pinned dependency integrity without unrelated lock entries', async () => {
  const f = await sourceTree(),
    original = await browserProductionSubject(f.root);
  const { readFile } = await import('node:fs/promises');
  const lock = JSON.parse(await readFile(join(f.root, 'pnpm-lock.yaml'), 'utf8'));
  lock.packages['unrelated@2.0.0'] = { resolution: { integrity: 'new-unrelated' } };
  lock.snapshots['unrelated@2.0.0'] = {};
  await f.write('pnpm-lock.yaml', JSON.stringify(lock));
  expect(await browserProductionSubject(f.root)).toBe(original);
  lock.packages['playwright-core@1.0.0'].resolution.integrity = 'changed-original';
  await f.write('pnpm-lock.yaml', JSON.stringify(lock));
  expect(await browserProductionSubject(f.root)).not.toBe(original);
});

it.each([
  'Object.freeze([...records])',
  'Object.freeze([makeRecord()])',
  'Object.freeze([{ get ready() { return true; } }])',
  'Object.freeze([{ value: process.env.VALUE }])',
  'Object.freeze([{ value: true ? 1 : 2 }])',
  'Object.freeze([{ __proto__: null }])',
  'Object.freeze([{ value: 1, value: 2 }])',
])('rejects executable catalogue metadata %s before any subject is issued', async (initializer) => {
  const f = await sourceTree();
  await f.write(catalogue, catalogueSource('[]').replace('Object.freeze([])', initializer));
  await expect(browserProductionSubject(f.root)).rejects.toThrow(
    'BROWSER_SUBJECT_CATALOGUE_EXECUTABLE'
  );
});
it('rejects executable top-level catalogue edits while literal publication preserves normalized input', async () => {
  const f = await sourceTree();
  const original = (await browserProductionInputs(f.root)).get(catalogue);
  expect(original).toBeDefined();
  await f.write(catalogue, catalogueSource('[{ gates: [{ count: 1 }] }]'));
  expect((await browserProductionInputs(f.root)).get(catalogue)).toEqual(original);
  await f.write(catalogue, catalogueSource('[]') + '\nprocess.exit(0);');
  await expect(browserProductionSubject(f.root)).rejects.toThrow(
    'BROWSER_SUBJECT_CATALOGUE_EXECUTABLE'
  );
});

it.each([false, true])(
  'binds genuine root-declared dependency only with exact ancestor resolution (nearer mismatch %s)',
  async (nearer) => {
    const f = await sourceTree();
    const { readFile } = await import('node:fs/promises');
    const lock = JSON.parse(await readFile(join(f.root, 'pnpm-lock.yaml'), 'utf8'));
    lock.importers['.'].dependencies = { 'owned-shared': { specifier: '1.0.0', version: '1.0.0' } };
    lock.packages['owned-shared@1.0.0'] = { resolution: { integrity: 'original-root' } };
    lock.snapshots['owned-shared@1.0.0'] = {};
    await f.write('pnpm-lock.yaml', JSON.stringify(lock));
    await f.write(
      'node_modules/owned-shared/package.json',
      JSON.stringify({ name: 'owned-shared', main: 'index.js' })
    );
    await f.write('node_modules/owned-shared/index.js', 'module.exports = 1;');
    await f.write(
      'apps/server/src/services/browser/egress/policy.ts',
      "import 'owned-shared'; export const policy = 1;"
    );
    if (nearer) {
      await f.write(
        'apps/server/node_modules/owned-shared/package.json',
        JSON.stringify({ name: 'owned-shared', main: 'index.js' })
      );
      await f.write('apps/server/node_modules/owned-shared/index.js', 'module.exports = 2;');
      await expect(browserProductionSubject(f.root)).rejects.toThrow(
        'BROWSER_SUBJECT_IMPORT_IDENTITY_MISMATCH'
      );
    } else {
      const inputs = await browserProductionInputs(f.root);
      expect(inputs.has('import/./owned-shared')).toBe(true);
      expect(inputs.has('lock/owned-shared@1.0.0')).toBe(true);
      const original = await browserProductionSubject(f.root);
      lock.packages['owned-shared@1.0.0'].resolution.integrity = 'changed-root';
      await f.write('pnpm-lock.yaml', JSON.stringify(lock));
      expect(await browserProductionSubject(f.root)).not.toBe(original);
    }
  }
);
it('refuses an undeclared dependency instead of searching unrelated lock importers', async () => {
  const f = await sourceTree();
  await f.write(
    'apps/server/src/services/browser/egress/policy.ts',
    "import 'undeclared-original';"
  );
  await expect(browserProductionSubject(f.root)).rejects.toThrow(
    'BROWSER_SUBJECT_IMPORT_UNAVAILABLE:apps/server:undeclared-original'
  );
});
