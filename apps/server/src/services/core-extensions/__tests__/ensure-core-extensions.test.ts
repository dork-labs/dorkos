import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ensureCoreExtensions } from '../ensure-core-extensions.js';

/**
 * Write a fake bundled core extension into `sourceRoot/<id>/` with a valid
 * `extension.json` plus a dummy `index.ts` asset (to assert the tree is copied).
 */
async function writeExtension(
  sourceRoot: string,
  id: string,
  opts: {
    version?: string;
    name?: string;
    defaultEnabled?: boolean;
    canDisable?: boolean;
  } = {}
): Promise<void> {
  const dir = path.join(sourceRoot, id);
  await fs.mkdir(dir, { recursive: true });
  const manifest: Record<string, unknown> = {
    id,
    name: opts.name ?? id,
    version: opts.version ?? '1.0.0',
  };
  if (opts.defaultEnabled !== undefined) manifest.defaultEnabled = opts.defaultEnabled;
  if (opts.canDisable !== undefined) manifest.canDisable = opts.canDisable;
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  await fs.writeFile(path.join(dir, 'index.ts'), '// fake core extension entry\n', 'utf-8');
}

describe('ensureCoreExtensions', () => {
  let dorkHome: string;
  let sourceRoot: string;

  beforeEach(async () => {
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ensure-core-dork-'));
    sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ensure-core-src-'));
  });

  afterEach(async () => {
    await fs.rm(dorkHome, { recursive: true, force: true });
    await fs.rm(sourceRoot, { recursive: true, force: true });
  });

  const destDir = (id: string) => path.join(dorkHome, 'extensions', id);
  const destManifest = (id: string) => path.join(destDir(id), 'extension.json');

  it('scans and stages every valid extension subdirectory', async () => {
    await writeExtension(sourceRoot, 'alpha');
    await writeExtension(sourceRoot, 'beta', { defaultEnabled: false });

    const info = await ensureCoreExtensions(dorkHome, sourceRoot);

    expect(info.map((i) => i.id).sort()).toEqual(['alpha', 'beta']);
    // Both extension trees copied, assets alongside the manifest.
    for (const id of ['alpha', 'beta']) {
      const entries = await fs.readdir(destDir(id));
      expect(entries).toEqual(expect.arrayContaining(['extension.json', 'index.ts']));
    }
  });

  it('skips subdirectories without a valid extension.json and non-directory entries', async () => {
    await writeExtension(sourceRoot, 'real');
    // A directory with no manifest.
    await fs.mkdir(path.join(sourceRoot, 'not-an-ext'), { recursive: true });
    // A directory with a junk manifest.
    await fs.mkdir(path.join(sourceRoot, 'junk-manifest'), { recursive: true });
    await fs.writeFile(
      path.join(sourceRoot, 'junk-manifest', 'extension.json'),
      'not json',
      'utf-8'
    );
    // A stray file at the source root.
    await fs.writeFile(path.join(sourceRoot, 'README.md'), '# not an extension', 'utf-8');

    const info = await ensureCoreExtensions(dorkHome, sourceRoot);

    expect(info.map((i) => i.id)).toEqual(['real']);
    await expect(fs.access(destDir('not-an-ext'))).rejects.toThrow();
    await expect(fs.access(destDir('junk-manifest'))).rejects.toThrow();
  });

  it('returns correct tier metadata derived via "!== false"', async () => {
    await writeExtension(sourceRoot, 'defaults'); // no tier fields
    await writeExtension(sourceRoot, 'off-locked', { defaultEnabled: false, canDisable: false });
    await writeExtension(sourceRoot, 'on-disableable', { defaultEnabled: true, canDisable: true });

    const info = await ensureCoreExtensions(dorkHome, sourceRoot);
    const byId = Object.fromEntries(info.map((i) => [i.id, i]));

    // Omitted fields → both default to true.
    expect(byId.defaults).toEqual({ id: 'defaults', defaultEnabled: true, canDisable: true });
    expect(byId['off-locked']).toEqual({
      id: 'off-locked',
      defaultEnabled: false,
      canDisable: false,
    });
    expect(byId['on-disableable']).toEqual({
      id: 'on-disableable',
      defaultEnabled: true,
      canDisable: true,
    });
  });

  it('stages an extension on fresh install', async () => {
    await writeExtension(sourceRoot, 'fresh', { version: '1.2.3', name: 'Fresh' });

    await ensureCoreExtensions(dorkHome, sourceRoot);

    const manifest = JSON.parse(await fs.readFile(destManifest('fresh'), 'utf-8')) as {
      id: string;
      version: string;
      name: string;
    };
    expect(manifest.id).toBe('fresh');
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.name).toBe('Fresh');
  });

  it('upgrades an extension when the installed version differs', async () => {
    await writeExtension(sourceRoot, 'upgradable', { version: '2.0.0' });
    // Pre-stage an older version at the destination.
    await fs.mkdir(destDir('upgradable'), { recursive: true });
    await fs.writeFile(
      destManifest('upgradable'),
      JSON.stringify({ id: 'upgradable', name: 'upgradable', version: '1.0.0' }, null, 2),
      'utf-8'
    );

    await ensureCoreExtensions(dorkHome, sourceRoot);

    const manifest = JSON.parse(await fs.readFile(destManifest('upgradable'), 'utf-8')) as {
      version: string;
    };
    expect(manifest.version).toBe('2.0.0');
    const entries = await fs.readdir(destDir('upgradable'));
    expect(entries).toEqual(expect.arrayContaining(['extension.json', 'index.ts']));
  });

  it('re-copies when the installed manifest is unreadable', async () => {
    await writeExtension(sourceRoot, 'corrupt', { version: '1.0.0' });
    await fs.mkdir(destDir('corrupt'), { recursive: true });
    await fs.writeFile(destManifest('corrupt'), 'not valid json', 'utf-8');

    await ensureCoreExtensions(dorkHome, sourceRoot);

    const manifest = JSON.parse(await fs.readFile(destManifest('corrupt'), 'utf-8')) as {
      version: string;
    };
    expect(manifest.version).toBe('1.0.0');
  });

  it('is a no-op when the installed version already matches', async () => {
    await writeExtension(sourceRoot, 'stable', { version: '3.1.4' });
    // Pre-stage the destination at the same version, with a sentinel file.
    await fs.mkdir(destDir('stable'), { recursive: true });
    await fs.writeFile(
      destManifest('stable'),
      JSON.stringify({ id: 'stable', name: 'stable', version: '3.1.4' }, null, 2),
      'utf-8'
    );
    const sentinelPath = path.join(destDir('stable'), 'sentinel.txt');
    await fs.writeFile(sentinelPath, 'untouched', 'utf-8');
    const beforeStat = await fs.stat(destManifest('stable'));

    await ensureCoreExtensions(dorkHome, sourceRoot);

    const afterStat = await fs.stat(destManifest('stable'));
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    // Sentinel survives because copyDirectory was never invoked.
    expect(await fs.readFile(sentinelPath, 'utf-8')).toBe('untouched');
  });

  it('is idempotent across repeat calls', async () => {
    await writeExtension(sourceRoot, 'idem', { version: '1.0.0' });

    const first = await ensureCoreExtensions(dorkHome, sourceRoot);
    const beforeStat = await fs.stat(destManifest('idem'));
    const second = await ensureCoreExtensions(dorkHome, sourceRoot);
    const afterStat = await fs.stat(destManifest('idem'));

    expect(first).toEqual(second);
    // Second call is a no-op: the staged manifest is not rewritten.
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it('returns an empty array when the source dir does not exist', async () => {
    const info = await ensureCoreExtensions(dorkHome, path.join(sourceRoot, 'does-not-exist'));
    expect(info).toEqual([]);
  });

  // --- Smoke test against the real bundled core-extension tree ---

  it('stages the bundled core extension set with correct tier metadata', async () => {
    const info = await ensureCoreExtensions(dorkHome);
    const byId = Object.fromEntries(info.map((i) => [i.id, i]));

    // Dork Hub ships enabled; Hello World and Linear Loop ship off (opt-in).
    expect(byId.marketplace).toEqual({ id: 'marketplace', defaultEnabled: true, canDisable: true });
    expect(byId['hello-world']).toEqual({
      id: 'hello-world',
      defaultEnabled: false,
      canDisable: true,
    });
    expect(byId['linear-issues']).toEqual({
      id: 'linear-issues',
      defaultEnabled: false,
      canDisable: true,
    });

    const manifest = JSON.parse(await fs.readFile(destManifest('marketplace'), 'utf-8')) as {
      id: string;
      name: string;
    };
    expect(manifest.id).toBe('marketplace');
    expect(manifest.name).toBe('Dork Hub');
  });
});
