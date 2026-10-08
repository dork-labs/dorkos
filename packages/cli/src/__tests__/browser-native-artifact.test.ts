import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import {
  browserNativeArtifactSource,
  importBrowserNativeArtifact,
} from '../../scripts/browser-native-artifact.js';

const roots: string[] = [];
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('loads the actual desktop asset producers through CommonJS without running the CLI', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--require',
      'tsx/cjs',
      '-e',
      'const build = require(process.argv[2]); console.log(typeof build.buildBrowserNativeAssets, typeof build.buildBrowserRuntimeAssets);',
      'desktop-import-consumer',
      fileURLToPath(new URL('../../scripts/build.ts', import.meta.url)),
    ],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 }
  );
  expect(output.trim()).toBe('function function');
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'browser-native-handoff-')));
  roots.push(root);
  const directory = join(root, 'artifact'),
    assets = join(root, 'publisher-assets');
  await mkdir(directory);
  await mkdir(assets);
  await mkdir(join(root, 'packages/browser/src/runtime/native'), { recursive: true });
  for (const name of [
    'packages/browser/scripts/build-native-observer.ts',
    'packages/cli/scripts/build.ts',
    'packages/cli/scripts/browser-native-artifact.ts',
    'packages/cli/scripts/release-cli.ts',
    'pnpm-lock.yaml',
  ]) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), 'original source: ' + name);
  }
  const sources = ['darwin-process-observer.c', 'darwin-process-observer.h'].map((name) => ({
    name,
    bytes: Buffer.byteLength(name),
    sha256: hash(name),
  }));
  for (const row of sources)
    await writeFile(join(root, 'packages/browser/src/runtime/native', row.name), row.name);
  // File-provenance semantic fixtures only; these bytes are never executed or native qualification.
  const binary = { name: 'darwin-process-observer', bytes: 12, sha256: hash('native bytes') };
  const native = JSON.stringify({
    version: 1,
    platform: 'darwin',
    arch: 'arm64',
    availability: 'available',
    reason: null,
    sourceDigest: hash(sources.map((row) => `${row.name}\0${row.sha256}\n`).join('')),
    sources,
    binary,
  });
  const workers = ['darwin-journal-worker.mjs', 'darwin-supervisor-worker.mjs'].map((name) => ({
    name,
    bytes: Buffer.byteLength(name),
    sha256: hash(name),
  }));
  const packaged = JSON.stringify({
    version: 1,
    platform: 'darwin',
    arch: 'arm64',
    availability: 'available',
    controllerSHA256: hash('producer cli'),
    nativeManifestSHA256: hash(native),
    workers,
  });
  const files = new Map<string, string>([
    ...sources.map((row) => [row.name, row.name] as [string, string]),
    [binary.name, 'native bytes'],
    ['darwin-process-observer.manifest.json', native],
    ...workers.map((row) => [row.name, row.name] as [string, string]),
    ['package-manifest.json', packaged],
    ['producer-cli.js', 'producer cli'],
  ]);
  for (const [name, bytes] of files) await writeFile(join(directory, name), bytes);
  for (const row of workers) await writeFile(join(assets, row.name), row.name);
  const manifest = {
    version: 1,
    platform: 'darwin',
    arch: 'arm64',
    sourceSHA256: await browserNativeArtifactSource(root),
    files: [...files].map(([name, bytes]) => ({
      name,
      bytes: Buffer.byteLength(bytes),
      sha256: hash(bytes),
    })),
  };
  const publish = async () => {
    const bytes = JSON.stringify(manifest);
    await writeFile(join(directory, 'handoff-manifest.json'), bytes);
    return hash(bytes);
  };
  const pin = await publish();
  return { root, directory, assets, files, manifest, publish, pin };
}
it('copies only a source-correlated observer and retains publisher-owned worker bytes', async () => {
  const f = await fixture();
  expect(await realpath(f.root)).toBe(f.root);
  const native = await importBrowserNativeArtifact(f.root, f.assets, f.directory, f.pin);
  expect(native.availability).toBe('available');
  expect(await readFile(join(f.assets, 'darwin-process-observer'), 'utf8')).toBe('native bytes');
  expect(await readFile(join(f.assets, 'darwin-journal-worker.mjs'), 'utf8')).toBe(
    'darwin-journal-worker.mjs'
  );
  await expect(readFile(join(f.assets, 'producer-cli.js'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
it.each([
  'pin',
  'source',
  'worker',
  'binary',
  'producer-controller',
  'native-source',
  'manifest-name',
  'symlink',
] as const)('rejects %s substitution before observer publication', async (kind) => {
  const f = await fixture();
  let pin = f.pin;
  if (kind === 'pin') pin = 'a'.repeat(64);
  if (kind === 'source') await writeFile(join(f.root, 'pnpm-lock.yaml'), 'changed');
  if (kind === 'worker') await writeFile(join(f.assets, 'darwin-supervisor-worker.mjs'), 'other');
  if (kind === 'binary') await writeFile(join(f.directory, 'darwin-process-observer'), 'changed');
  if (kind === 'producer-controller') {
    await writeFile(join(f.directory, 'producer-cli.js'), 'other cli');
    f.manifest.files.at(-1)!.bytes = 9;
    f.manifest.files.at(-1)!.sha256 = hash('other cli');
    pin = await f.publish();
  }
  if (kind === 'native-source') {
    await writeFile(join(f.directory, 'darwin-process-observer.c'), 'other c');
    f.manifest.files[0].bytes = 7;
    f.manifest.files[0].sha256 = hash('other c');
    pin = await f.publish();
  }
  if (kind === 'manifest-name') {
    f.manifest.files[0].name = '../outside';
    pin = await f.publish();
  }
  if (kind === 'symlink') {
    await rm(join(f.directory, 'darwin-process-observer'));
    await symlink(
      join(f.directory, 'producer-cli.js'),
      join(f.directory, 'darwin-process-observer')
    );
  }
  const refused = {
    pin: 'NATIVE_HANDOFF_PIN_MISMATCH',
    source: 'NATIVE_HANDOFF_SOURCE_MISMATCH',
    worker: 'NATIVE_HANDOFF_WORKER_MISMATCH',
    binary: 'NATIVE_HANDOFF_CHANGED',
    'producer-controller': 'NATIVE_HANDOFF_CHANGED',
    'native-source': 'NATIVE_HANDOFF_CHANGED',
    'manifest-name': 'NATIVE_HANDOFF_CHANGED',
    symlink: 'NATIVE_HANDOFF_FILE_INVALID',
  } as const;
  await expect(
    importBrowserNativeArtifact(f.root, f.assets, f.directory, pin)
  ).rejects.toMatchObject({
    message: refused[kind],
  });
  await expect(readFile(join(f.assets, 'darwin-process-observer'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it.each(['entries', 'depth'] as const)(
  'bounds original source traversal for %s without needing source files',
  async (kind) => {
    const f = await fixture();
    const source = join(f.root, 'packages/browser/src');
    if (kind === 'entries') {
      for (let index = 0; index < 2049; index++) await mkdir(join(source, 'empty-' + index));
    } else {
      await mkdir(join(source, ...Array.from({ length: 33 }, () => 'empty')), { recursive: true });
    }
    await expect(browserNativeArtifactSource(f.root)).rejects.toThrow(
      /NATIVE_HANDOFF_SOURCE_(ENTRY|DEPTH)_CAP/
    );
  }
);
it('fingerprints actual source names in codepoint order across directory insertion order', async () => {
  const a = await fixture();
  const b = await fixture();
  for (const name of ['z.ts', 'ä.ts', 'A.ts'])
    await writeFile(join(a.root, 'packages/browser/src', name), name);
  for (const name of ['A.ts', 'ä.ts', 'z.ts'])
    await writeFile(join(b.root, 'packages/browser/src', name), name);
  expect(await browserNativeArtifactSource(a.root)).toBe(await browserNativeArtifactSource(b.root));
});
