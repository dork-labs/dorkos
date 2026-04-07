/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanInstalledPackages } from '../installed-scanner.js';
import { INSTALL_METADATA_PATH } from '../installed-metadata.js';

/**
 * Write a `.dork/manifest.json` to a package root, creating the directory tree
 * if needed. Mirrors what the install pipeline does for the manifest copy.
 */
async function writeManifest(
  packagePath: string,
  manifest: Record<string, unknown>
): Promise<void> {
  const dir = join(packagePath, '.dork');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
}

/**
 * Write a `.dork/install-metadata.json` sidecar to a package root. Mirrors
 * the install pipeline's `writeInstallMetadata()` output.
 */
async function writeMetadata(
  packagePath: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const target = join(packagePath, INSTALL_METADATA_PATH);
  await mkdir(join(packagePath, '.dork'), { recursive: true });
  await writeFile(target, JSON.stringify(metadata, null, 2), 'utf-8');
}

describe('scanInstalledPackages', () => {
  let dorkHome: string;

  beforeEach(async () => {
    dorkHome = await mkdtemp(join(tmpdir(), 'dorkos-installed-scanner-'));
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('returns empty list when dorkHome has no plugins or agents', async () => {
    const result = await scanInstalledPackages(dorkHome);
    expect(result).toEqual([]);
  });

  it('walks plugins and agents directories and returns merged list', async () => {
    const pluginDir = join(dorkHome, 'plugins', 'sentry-monitor');
    await writeManifest(pluginDir, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'sentry-monitor',
      version: '1.2.3',
    });
    await writeMetadata(pluginDir, {
      name: 'sentry-monitor',
      version: '1.2.3',
      type: 'plugin',
      installedFrom: 'community',
      installedAt: '2026-01-15T10:00:00.000Z',
    });

    const agentDir = join(dorkHome, 'agents', 'researcher');
    await writeManifest(agentDir, {
      schemaVersion: 1,
      type: 'agent',
      name: 'researcher',
      version: '0.5.0',
    });
    await writeMetadata(agentDir, {
      name: 'researcher',
      version: '0.5.0',
      type: 'agent',
      installedFrom: 'personal',
      installedAt: '2026-02-01T08:30:00.000Z',
    });

    const result = await scanInstalledPackages(dorkHome);
    const sorted = [...result].sort((a, b) => a.name.localeCompare(b.name));

    expect(sorted).toHaveLength(2);
    expect(sorted[0]).toEqual({
      name: 'researcher',
      version: '0.5.0',
      type: 'agent',
      installPath: agentDir,
      installedFrom: 'personal',
      installedAt: '2026-02-01T08:30:00.000Z',
    });
    expect(sorted[1]).toEqual({
      name: 'sentry-monitor',
      version: '1.2.3',
      type: 'plugin',
      installPath: pluginDir,
      installedFrom: 'community',
      installedAt: '2026-01-15T10:00:00.000Z',
    });
  });

  it('omits provenance fields when the install-metadata sidecar is missing', async () => {
    const pluginDir = join(dorkHome, 'plugins', 'orphan-plugin');
    await writeManifest(pluginDir, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'orphan-plugin',
      version: '0.1.0',
    });

    const result = await scanInstalledPackages(dorkHome);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'orphan-plugin',
      version: '0.1.0',
      type: 'plugin',
      installPath: pluginDir,
    });
    expect(result[0].installedFrom).toBeUndefined();
    expect(result[0].installedAt).toBeUndefined();
  });

  it('skips package directories with missing or unreadable manifests', async () => {
    // Directory exists with no manifest at all.
    await mkdir(join(dorkHome, 'plugins', 'empty-dir'), { recursive: true });

    // Valid plugin alongside the broken one.
    const goodDir = join(dorkHome, 'plugins', 'good-plugin');
    await writeManifest(goodDir, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'good-plugin',
      version: '1.0.0',
    });

    const result = await scanInstalledPackages(dorkHome);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('good-plugin');
  });

  it('only walks plugins/ and agents/, ignoring sibling directories', async () => {
    // Stash a "package-like" tree under an unrelated dir.
    const strayDir = join(dorkHome, 'somewhere-else', 'rogue');
    await writeManifest(strayDir, {
      schemaVersion: 1,
      type: 'plugin',
      name: 'rogue',
      version: '1.0.0',
    });

    const result = await scanInstalledPackages(dorkHome);
    expect(result).toEqual([]);
  });
});
