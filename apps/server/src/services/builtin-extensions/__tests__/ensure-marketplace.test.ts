import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ensureBuiltinMarketplaceExtension } from '../ensure-marketplace.js';

/**
 * Version shipped in the canonical source manifest at
 * `apps/server/src/builtin-extensions/marketplace/extension.json`.
 * Keep in sync with that file — if it bumps, this constant must bump too.
 */
const BUNDLED_VERSION = '1.0.0';

describe('ensureBuiltinMarketplaceExtension', () => {
  let dorkHome: string;
  let destDir: string;
  let destManifestPath: string;

  beforeEach(async () => {
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ensure-marketplace-test-'));
    destDir = path.join(dorkHome, 'extensions', 'marketplace');
    destManifestPath = path.join(destDir, 'extension.json');
  });

  afterEach(async () => {
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  it('stages the extension on fresh install', async () => {
    await ensureBuiltinMarketplaceExtension(dorkHome);

    const raw = await fs.readFile(destManifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as { id: string; version: string; name: string };

    expect(manifest.id).toBe('marketplace');
    expect(manifest.version).toBe(BUNDLED_VERSION);
    expect(manifest.name).toBe('Dork Hub');

    // Source-tree assets should be copied alongside the manifest.
    const entries = await fs.readdir(destDir);
    expect(entries).toEqual(expect.arrayContaining(['extension.json', 'index.ts', 'server.ts']));
  });

  it('upgrades the extension when the installed version differs', async () => {
    // Pre-create an older version at the destination.
    await fs.mkdir(destDir, { recursive: true });
    const olderManifest = {
      id: 'marketplace',
      name: 'Dork Hub',
      version: '0.9.0',
      description: 'Older Dork Hub manifest used to simulate an upgrade.',
      author: 'DorkOS',
      minHostVersion: '0.1.0',
      contributions: { 'sidebar.tabs': true },
    };
    await fs.writeFile(destManifestPath, JSON.stringify(olderManifest, null, 2), 'utf-8');
    // Stale asset that should survive copy (fs.cp merges, does not prune).
    await fs.writeFile(path.join(destDir, 'stale.txt'), 'leftover', 'utf-8');

    await ensureBuiltinMarketplaceExtension(dorkHome);

    const raw = await fs.readFile(destManifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as { version: string };
    expect(manifest.version).toBe(BUNDLED_VERSION);

    // Canonical source files should now be present.
    const entries = await fs.readdir(destDir);
    expect(entries).toEqual(expect.arrayContaining(['extension.json', 'index.ts', 'server.ts']));
  });

  it('is a no-op when the installed version already matches', async () => {
    // Pre-create the destination with the current bundled version.
    await fs.mkdir(destDir, { recursive: true });
    const currentManifest = {
      id: 'marketplace',
      name: 'Dork Hub',
      version: BUNDLED_VERSION,
      description: 'Pre-staged at the bundled version.',
      author: 'DorkOS',
      minHostVersion: '0.1.0',
      contributions: { 'sidebar.tabs': true },
    };
    await fs.writeFile(destManifestPath, JSON.stringify(currentManifest, null, 2), 'utf-8');
    const sentinelPath = path.join(destDir, 'sentinel.txt');
    await fs.writeFile(sentinelPath, 'untouched', 'utf-8');

    // Snapshot mtime to detect unexpected rewrites of the manifest.
    const beforeStat = await fs.stat(destManifestPath);

    await ensureBuiltinMarketplaceExtension(dorkHome);

    const afterStat = await fs.stat(destManifestPath);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);

    // Sentinel must remain because copyDirectory was never invoked.
    const sentinel = await fs.readFile(sentinelPath, 'utf-8');
    expect(sentinel).toBe('untouched');

    // Manifest content preserved verbatim.
    const raw = await fs.readFile(destManifestPath, 'utf-8');
    expect(JSON.parse(raw)).toEqual(currentManifest);
  });

  it('re-copies the source tree when the installed manifest is unreadable', async () => {
    // Simulate a corrupt install: destination exists but manifest is junk.
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(destManifestPath, 'not valid json', 'utf-8');

    await ensureBuiltinMarketplaceExtension(dorkHome);

    const raw = await fs.readFile(destManifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as { version: string };
    expect(manifest.version).toBe(BUNDLED_VERSION);
  });
});
