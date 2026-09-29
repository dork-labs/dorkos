/**
 * Verified, content-addressed plugin snapshots (third security review of
 * DOR-2527, `extension-snapshots.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { collectSnapshots, ensureSnapshot, snapshotRootOf } from '../extension-snapshots.js';
import { installFolderDigest } from '../../marketplace/lib/install-digest.js';

let tmp: string;
let dorkHome: string;
let plugin: string;

async function write(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

async function digestOf(root: string): Promise<string> {
  const found = await installFolderDigest(root);
  if (found.kind !== 'digest') throw new Error(found.kind);
  return found.digest;
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ext-snapshots-')));
  dorkHome = path.join(tmp, 'dork');
  plugin = path.join(tmp, 'repo', '.dork', 'plugins', 'flow');
  await write(path.join(plugin, '.dork', 'extensions', 'flow', 'index.ts'), 'export {};\n');
  await write(path.join(plugin, 'scripts', 'config-files.ts'), '// shipped\n');
  await write(path.join(plugin, '.dork', 'secrets.json'), '{"token":"x"}');
  await write(path.join(plugin, '.git', 'HEAD'), 'ref: refs/heads/main\n');
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('ensureSnapshot', () => {
  it('copies exactly what the digest covers, named by that digest, and reuses it', async () => {
    const digest = await digestOf(plugin);
    const root = await ensureSnapshot(dorkHome, plugin, digest);

    expect(root).toBe(snapshotRootOf(dorkHome, digest));
    expect(await fs.readFile(path.join(root!, 'scripts', 'config-files.ts'), 'utf8')).toBe(
      '// shipped\n'
    );
    // DorkOS's runtime state and `.git` stay behind.
    await expect(fs.access(path.join(root!, '.dork', 'secrets.json'))).rejects.toThrow();
    await expect(fs.access(path.join(root!, '.git'))).rejects.toThrow();
    expect(await digestOf(root!)).toBe(digest);

    // The live folder changing later does not touch the snapshot, and the same
    // digest finds the same snapshot again without copying.
    await write(path.join(plugin, 'scripts', 'config-files.ts'), '// evil\n');
    expect(await ensureSnapshot(dorkHome, plugin, digest)).toBe(root);
    expect(await fs.readFile(path.join(root!, 'scripts', 'config-files.ts'), 'utf8')).toBe(
      '// shipped\n'
    );
  });

  it('refuses when the live folder no longer holds the proved files', async () => {
    const digest = await digestOf(plugin);
    await write(path.join(plugin, 'scripts', 'config-files.ts'), '// evil\n');

    expect(await ensureSnapshot(dorkHome, plugin, digest)).toBeNull();
    expect(await fs.readdir(path.join(dorkHome, 'extension-snapshots'))).toEqual([]);
  });

  it('refuses a folder holding a symbolic link', async () => {
    await fs.symlink('/etc/hosts', path.join(plugin, 'scripts', 'hosts'));
    expect(await ensureSnapshot(dorkHome, plugin, 'sha256:' + 'a'.repeat(64))).toBeNull();
  });
});

describe('collectSnapshots', () => {
  it('removes snapshots nothing runs from and stale half-written copies, and keeps the rest', async () => {
    const kept = await ensureSnapshot(dorkHome, plugin, await digestOf(plugin));
    await write(path.join(plugin, 'scripts', 'config-files.ts'), '// v2\n');
    const unused = await ensureSnapshot(dorkHome, plugin, await digestOf(plugin));
    const staleTemp = path.join(dorkHome, 'extension-snapshots', '.tmp-old');
    const freshTemp = path.join(dorkHome, 'extension-snapshots', '.tmp-new');
    await fs.mkdir(staleTemp);
    await fs.mkdir(freshTemp);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await fs.utimes(staleTemp, old, old);

    const removed = await collectSnapshots(dorkHome, new Set([kept!]));

    expect(removed.sort()).toEqual([unused!, staleTemp].sort());
    await expect(fs.access(kept!)).resolves.toBeUndefined();
    await expect(fs.access(freshTemp)).resolves.toBeUndefined();
  });
});
