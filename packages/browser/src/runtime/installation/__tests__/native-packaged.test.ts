import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstallationConfiguration } from '../contracts.js';
import { resolveInstalledNativeJournal } from '../packaged.js';

const roots: string[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dorkos-native-package-')));
  roots.push(root);
  const directory = join(root, 'dist/browser/native'),
    controllerEntry = join(root, 'dist/bin/cli.js');
  await mkdir(directory, { recursive: true });
  await mkdir(join(root, 'dist/bin'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dorkos' }));
  await writeFile(controllerEntry, 'original cli');
  const workers = ['darwin-journal-worker.mjs', 'darwin-supervisor-worker.mjs'].map((name) => ({
    name,
    sha256: hash(name),
    bytes: Buffer.byteLength(name),
  }));
  const sources = ['darwin-process-observer.c', 'darwin-process-observer.h'].map((name) => ({
    name,
    sha256: hash(name),
    bytes: Buffer.byteLength(name),
  }));
  const binary = {
    name: 'darwin-process-observer',
    sha256: hash('original binary'),
    bytes: Buffer.byteLength('original binary'),
  };
  for (const row of [...workers, ...sources]) await writeFile(join(directory, row.name), row.name);
  await writeFile(join(directory, binary.name), 'original binary', { mode: 0o755 });
  const native = {
    version: 1,
    platform: 'darwin',
    arch: 'arm64',
    availability: 'available',
    reason: null,
    sources,
    sourceDigest: hash(sources.map((source) => `${source.name}\0${source.sha256}\n`).join('')),
    binary,
  };
  const nativeBytes = JSON.stringify(native) + '\n';
  await writeFile(join(directory, 'darwin-process-observer.manifest.json'), nativeBytes);
  const manifest = {
    version: 1,
    controllerSHA256: hash('original cli'),
    nativeManifestSHA256: hash(nativeBytes),
    platform: 'darwin',
    arch: 'arm64',
    availability: 'available',
    workers,
  };
  const publish = () =>
    writeFile(join(directory, 'package-manifest.json'), JSON.stringify(manifest));
  await publish();
  // File-only provenance fixtures are not executable native workers and never prove readiness.
  vi.stubGlobal('process', { ...process, platform: 'darwin', arch: 'arm64' });
  const configuration = {
    controllerEntry,
    platform: 'darwin',
    arch: 'arm64',
    sourceVintage: { controllerSHA256: hash('original cli') },
  } as unknown as InstallationConfiguration;
  return { directory, configuration, manifest, publish };
}
describe('packaged native original file provenance', () => {
  it('resolves only fixed original package-relative worker/helper paths without readiness', async () => {
    const f = await setup(),
      journal = await resolveInstalledNativeJournal(f.configuration);
    expect(journal.workerPath).toBe(join(f.directory, 'darwin-journal-worker.mjs'));
    expect(journal.browserWorkerPath).toBe(join(f.directory, 'darwin-supervisor-worker.mjs'));
    expect(journal.artifact.sha256).toBe(hash('original binary'));
    expect(Object.isFrozen(journal.artifact)).toBe(true);
    expect('readiness' in journal).toBe(false);
  });
  it('refuses unsupported original host instead of substituting fixture paths', async () => {
    const f = await setup();
    vi.stubGlobal('process', { ...process, platform: 'linux', arch: 'x64' });
    await expect(resolveInstalledNativeJournal(f.configuration)).rejects.toThrow('unavailable');
  });
  it('rejects missing/changed workers even if an old manifest says available', async () => {
    const f = await setup();
    await writeFile(join(f.directory, 'darwin-journal-worker.mjs'), 'changed');
    await expect(resolveInstalledNativeJournal(f.configuration)).rejects.toThrow('changed');
    await rm(join(f.directory, 'darwin-supervisor-worker.mjs'));
    await expect(resolveInstalledNativeJournal(f.configuration)).rejects.toThrow();
  });
  it('rejects symlink worker substitution and an injected manifest worker name', async () => {
    const f = await setup();
    const worker = join(f.directory, 'darwin-journal-worker.mjs');
    await rm(worker);
    await symlink(join(f.directory, 'darwin-supervisor-worker.mjs'), worker);
    await expect(resolveInstalledNativeJournal(f.configuration)).rejects.toThrow();
    f.manifest.workers[0]!.name = '../outside-worker';
    await f.publish();
    await expect(resolveInstalledNativeJournal(f.configuration)).rejects.toThrow();
  });
  it('refuses unavailable native build output and changed original binary', async () => {
    const f = await setup();
    f.manifest.availability = 'unavailable';
    await f.publish();
    await expect(resolveInstalledNativeJournal(f.configuration)).rejects.toThrow('unavailable');
    f.manifest.availability = 'available';
    await f.publish();
    await writeFile(join(f.directory, 'darwin-process-observer'), 'different native binary');
    await expect(resolveInstalledNativeJournal(f.configuration)).rejects.toThrow('changed');
  });
});
