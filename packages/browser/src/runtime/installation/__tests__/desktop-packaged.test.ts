import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import {
  resolveInstalledRuntimeConfiguration,
  resolveInstalledNativeJournal,
} from '../packaged.js';

// Actual file-layout/provenance controls only. No Electron/native process or installed-app claim.
const roots: string[] = [];
const originalProcess = process;
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'desktop-browser-package-')));
  roots.push(directory);
  const contents = join(directory, 'DorkOS.app/Contents');
  const root = join(contents, 'Resources/app.asar.unpacked');
  const controller = join(root, 'dist/server/server-entry.mjs');
  const executable = join(contents, 'MacOS/DorkOS');
  const framework = join(
    contents,
    'Frameworks/Electron Framework.framework/Versions/A/Electron Framework'
  );
  const home = join(directory, 'private-profile');
  for (const path of ['dist/server', 'dist/browser', 'node_modules/playwright-core'])
    await mkdir(join(root, path), { recursive: true });
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await mkdir(join(contents, 'Frameworks/Electron Framework.framework/Versions/A'), {
    recursive: true,
  });
  await mkdir(home);
  await writeFile(executable, 'original Electron launcher', { mode: 0o755 });
  await writeFile(framework, 'original Electron framework', { mode: 0o755 });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@dorkos/desktop' }));
  await writeFile(
    join(root, 'node_modules/playwright-core/package.json'),
    JSON.stringify({ name: 'playwright-core', version: '1.63.0' })
  );
  await writeFile(join(root, 'dist/browser/fresh-verifier.mjs'), 'original verifier');
  const publish = async (body: string) => {
    await writeFile(controller, body);
    await writeFile(
      join(root, 'dist/browser/source-manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        controllerSHA256: hash(body),
        verifierSHA256: hash('original verifier'),
      })
    );
  };
  await publish('original desktop controller');
  const mockProcess = (changes: Record<string, unknown> = {}) => {
    vi.stubGlobal('process', {
      ...originalProcess,
      platform: 'darwin',
      arch: 'arm64',
      type: 'utility',
      versions: { ...originalProcess.versions, electron: '41.10.7' },
      env: {
        ...originalProcess.env,
        DORKOS_BROWSER_DESKTOP_NODE_EXECUTABLE: executable,
      },
      ...changes,
    });
  };
  mockProcess();
  const resolve = () => resolveInstalledRuntimeConfiguration(pathToFileURL(controller), home);
  return {
    directory,
    root,
    controller,
    executable,
    framework,
    home,
    publish,
    mockProcess,
    resolve,
  };
}
it('binds the one real unpacked desktop controller, launcher/framework and library without readiness', async () => {
  const f = await fixture();
  const config = await f.resolve();
  expect(config.controllerEntry).toBe(f.controller);
  expect(config.nodeExecutable).toBe(f.executable);
  expect(config.nodeRuntime).toBe('electron-node');
  expect(config.electronFramework).toEqual({
    path: f.framework,
    sha256: hash('original Electron framework'),
  });
  expect(config.libraryRoot).toBe(join(f.root, 'node_modules/playwright-core'));
  expect('readiness' in config).toBe(false);
});
it('preserves old exact cache and named private profile across upgrade then rollback', async () => {
  const f = await fixture();
  const before = await f.resolve();
  await mkdir(before.cacheRoot, { recursive: true });
  await writeFile(join(before.cacheRoot, 'current.json'), 'original old-slot marker');
  const profile = join(f.home, 'named-private-profile');
  await writeFile(profile, 'original private profile');
  await f.publish('upgraded desktop controller');
  const upgraded = await f.resolve();
  expect(upgraded.cacheRoot).not.toBe(before.cacheRoot);
  expect(upgraded.sourceVintage.controllerSHA256).not.toBe(before.sourceVintage.controllerSHA256);
  await f.publish('original desktop controller');
  const rolledBack = await f.resolve();
  expect(rolledBack.cacheRoot).toBe(before.cacheRoot);
  expect(await readFile(join(before.cacheRoot, 'current.json'), 'utf8')).toBe(
    'original old-slot marker'
  );
  expect(await readFile(profile, 'utf8')).toBe('original private profile');
});
it('refuses unqualified main executable even when a utility process claims Electron', async () => {
  const f = await fixture();
  const alternate = join(f.directory, 'foreign-electron');
  await writeFile(alternate, 'foreign launcher');
  f.mockProcess({ env: { DORKOS_BROWSER_DESKTOP_NODE_EXECUTABLE: alternate } });
  await expect(f.resolve()).rejects.toThrow('does not match this installed app');
});
it('refuses desktop files in a plain Node process', async () => {
  const f = await fixture();
  f.mockProcess({ versions: originalProcess.versions, type: undefined });
  await expect(f.resolve()).rejects.toThrow('packaged DorkOS controller');
});
it('keeps Windows desktop managed runtime unavailable', async () => {
  const f = await fixture();
  f.mockProcess({ platform: 'win32', arch: 'x64' });
  await expect(f.resolve()).rejects.toThrow('packaged DorkOS controller');
});
it('refuses foreign/cache library resolution outside the same unpacked app', async () => {
  const f = await fixture();
  const foreign = join(f.directory, 'foreign-library');
  await mkdir(foreign);
  await writeFile(
    join(foreign, 'package.json'),
    JSON.stringify({ name: 'playwright-core', version: '1.63.0' })
  );
  await rm(join(f.root, 'node_modules/playwright-core'), { recursive: true });
  await symlink(foreign, join(f.root, 'node_modules/playwright-core'));
  await expect(f.resolve()).rejects.toThrow('unpacked inside this original app');
});
it('refuses ancestor library fallback separately from changed controller/verifier source', async () => {
  const f = await fixture();
  await writeFile(f.controller, 'damaged controller');
  await expect(f.resolve()).rejects.toThrow('manifest does not match');
  await f.publish('original desktop controller');
  // Removing the owned package permits Node's genuine ancestor lookup. Provide a
  // controlled ancestor so refusal does not depend on the developer's installed SDK.
  const ancestor = join(f.directory, 'node_modules/playwright-core');
  await mkdir(ancestor, { recursive: true });
  await writeFile(
    join(ancestor, 'package.json'),
    JSON.stringify({ name: 'playwright-core', version: '1.63.0' })
  );
  await rm(join(f.root, 'node_modules/playwright-core/package.json'));
  expect(createRequire(f.controller).resolve('playwright-core/package.json')).toBe(
    join(ancestor, 'package.json')
  );
  await expect(f.resolve()).rejects.toThrow(
    'The desktop browser library must be unpacked inside this original app.'
  );
});

it('refuses an absent original Electron runtime separately from a present pinned library', async () => {
  const f = await fixture();
  await rm(f.framework);
  await expect(f.resolve()).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['launcher', 'framework'] as const)(
  'refuses changed original Electron %s before native workers/assets acquisition',
  async (part) => {
    const f = await fixture();
    const configuration = await f.resolve();
    await writeFile(part === 'launcher' ? f.executable : f.framework, 'changed original runtime');
    await expect(resolveInstalledNativeJournal(configuration)).rejects.toThrow(
      'native launcher changed'
    );
  }
);

it('refuses a failed upgrade provenance read without replacing the old cache or private profile', async () => {
  const f = await fixture();
  const original = await f.resolve();
  await mkdir(original.cacheRoot, { recursive: true });
  const pointer = join(original.cacheRoot, 'current.json');
  const profile = join(f.home, 'named-private-profile');
  await writeFile(pointer, 'retained original publication');
  await writeFile(profile, 'retained private profile');
  await f.publish('attempted upgrade controller');
  await writeFile(join(f.root, 'dist/browser/fresh-verifier.mjs'), 'tampered upgrade verifier');
  await expect(f.resolve()).rejects.toThrow();
  expect(await readFile(pointer, 'utf8')).toBe('retained original publication');
  expect(await readFile(profile, 'utf8')).toBe('retained private profile');
  await writeFile(join(f.root, 'dist/browser/fresh-verifier.mjs'), 'original verifier');
  await f.publish('original desktop controller');
  const restored = await f.resolve();
  expect(restored.cacheRoot).toBe(original.cacheRoot);
  expect(restored.sourceVintage).toEqual(original.sourceVintage);
});
