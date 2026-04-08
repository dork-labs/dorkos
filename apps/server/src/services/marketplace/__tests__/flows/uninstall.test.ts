/**
 * Tests for {@link UninstallFlow}.
 *
 * Each test stages a handcrafted installed package on disk under a temp
 * `dorkHome`, then drives `UninstallFlow.uninstall()` with mocked
 * extension/adapter managers. The six cases below cover the four success
 * scenarios (plugin, adapter, purge=false data preservation, purge=true
 * full removal), the missing-package failure path, and the rollback
 * guarantee that an unexpected throw mid-uninstall leaves the original
 * package intact on disk.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import type {
  AdapterPackageManifest,
  MarketplacePackageManifest,
  PluginPackageManifest,
} from '@dorkos/marketplace';
import { PackageNotInstalledError, UninstallFlow } from '../../flows/uninstall.js';

/** Construct a no-op logger that satisfies the {@link Logger} interface. */
function buildLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Build a minimal valid {@link PluginPackageManifest}. */
function buildPluginManifest(
  overrides: Partial<PluginPackageManifest> = {}
): PluginPackageManifest {
  return {
    schemaVersion: 1,
    name: 'fixture-plugin',
    version: '0.1.0',
    type: 'plugin',
    description: 'Fixture plugin used by uninstall tests.',
    tags: [],
    layers: [],
    requires: [],
    extensions: [],
    ...overrides,
  };
}

/** Build a minimal valid {@link AdapterPackageManifest}. */
function buildAdapterManifest(
  overrides: Partial<AdapterPackageManifest> = {}
): AdapterPackageManifest {
  return {
    schemaVersion: 1,
    name: 'fixture-adapter',
    version: '0.1.0',
    type: 'adapter',
    description: 'Fixture adapter used by uninstall tests.',
    tags: [],
    layers: [],
    requires: [],
    adapterType: 'fixture',
    ...overrides,
  };
}

/** Returns true if `target` exists on disk. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stage a fake installed package on disk under `installRoot`.
 *
 * Writes the manifest, optional extension descriptors under
 * `.dork/extensions/<id>/extension.json`, optional `.dork/data/<file>`
 * payloads, and an optional `.dork/secrets.json`.
 */
async function stageInstalledPackage(opts: {
  installRoot: string;
  manifest: MarketplacePackageManifest;
  extensions?: { id: string; manifest: Record<string, unknown> }[];
  dataFiles?: { name: string; content: string }[];
  secrets?: Record<string, unknown>;
}): Promise<void> {
  await mkdir(opts.installRoot, { recursive: true });
  await mkdir(path.join(opts.installRoot, '.dork'), { recursive: true });
  await writeFile(
    path.join(opts.installRoot, '.dork', 'manifest.json'),
    JSON.stringify(opts.manifest, null, 2),
    'utf-8'
  );

  for (const ext of opts.extensions ?? []) {
    const extDir = path.join(opts.installRoot, '.dork', 'extensions', ext.id);
    await mkdir(extDir, { recursive: true });
    await writeFile(
      path.join(extDir, 'extension.json'),
      JSON.stringify(ext.manifest, null, 2),
      'utf-8'
    );
  }

  if (opts.dataFiles && opts.dataFiles.length > 0) {
    const dataDir = path.join(opts.installRoot, '.dork', 'data');
    await mkdir(dataDir, { recursive: true });
    for (const file of opts.dataFiles) {
      await writeFile(path.join(dataDir, file.name), file.content, 'utf-8');
    }
  }

  if (opts.secrets) {
    await mkdir(path.join(opts.installRoot, '.dork'), { recursive: true });
    await writeFile(
      path.join(opts.installRoot, '.dork', 'secrets.json'),
      JSON.stringify(opts.secrets, null, 2),
      'utf-8'
    );
  }
}

/** Build a UninstallFlowDeps-compatible deps object with mock managers. */
async function buildDeps(): Promise<{
  dorkHome: string;
  extensionManager: { disable: ReturnType<typeof vi.fn> };
  adapterManager: { removeAdapter: ReturnType<typeof vi.fn> };
  logger: Logger;
}> {
  const dorkHome = await mkdtemp(path.join(tmpdir(), 'uninstall-home-'));
  return {
    dorkHome,
    extensionManager: {
      disable: vi.fn().mockResolvedValue({ extension: {}, reloadRequired: true }),
    },
    adapterManager: {
      removeAdapter: vi.fn().mockResolvedValue(undefined),
    },
    logger: buildLogger(),
  };
}

describe('UninstallFlow', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('removes a plugin directory and disables every bundled extension', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const installRoot = path.join(deps.dorkHome, 'plugins', 'plugin-a');
    await stageInstalledPackage({
      installRoot,
      manifest: buildPluginManifest({ name: 'plugin-a', extensions: ['ext-a', 'ext-b'] }),
      extensions: [
        { id: 'ext-a', manifest: { id: 'ext-a' } },
        { id: 'ext-b', manifest: { id: 'ext-b' } },
      ],
    });

    const flow = new UninstallFlow(deps);
    const result = await flow.uninstall({ name: 'plugin-a' });

    expect(result.ok).toBe(true);
    expect(result.packageName).toBe('plugin-a');
    expect(result.preservedData).toEqual([]);
    expect(await pathExists(installRoot)).toBe(false);
    expect(deps.extensionManager.disable).toHaveBeenCalledTimes(2);
    expect(deps.extensionManager.disable).toHaveBeenCalledWith('ext-a');
    expect(deps.extensionManager.disable).toHaveBeenCalledWith('ext-b');
    expect(deps.adapterManager.removeAdapter).not.toHaveBeenCalled();
  });

  it('removes adapter package files and calls adapterManager.removeAdapter', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const installRoot = path.join(deps.dorkHome, 'plugins', 'adapter-a');
    await stageInstalledPackage({
      installRoot,
      manifest: buildAdapterManifest({ name: 'adapter-a', adapterType: 'fixture' }),
    });

    const flow = new UninstallFlow(deps);
    const result = await flow.uninstall({ name: 'adapter-a' });

    expect(result.ok).toBe(true);
    expect(result.packageName).toBe('adapter-a');
    expect(await pathExists(installRoot)).toBe(false);
    expect(deps.adapterManager.removeAdapter).toHaveBeenCalledTimes(1);
    expect(deps.adapterManager.removeAdapter).toHaveBeenCalledWith('adapter-a');
    expect(deps.extensionManager.disable).not.toHaveBeenCalled();
  });

  it('preserves .dork/data/ and .dork/secrets.json when purge is false', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const installRoot = path.join(deps.dorkHome, 'plugins', 'plugin-with-data');
    await stageInstalledPackage({
      installRoot,
      manifest: buildPluginManifest({ name: 'plugin-with-data' }),
      dataFiles: [
        { name: 'state.json', content: '{"foo":1}' },
        { name: 'cache.bin', content: 'opaque' },
      ],
      secrets: { token: 'shh' },
    });

    const flow = new UninstallFlow(deps);
    const result = await flow.uninstall({ name: 'plugin-with-data' });

    expect(result.ok).toBe(true);
    // Package manifest removed.
    expect(await pathExists(path.join(installRoot, '.dork', 'manifest.json'))).toBe(false);
    // Data and secrets re-created in the live location.
    const dataDir = path.join(installRoot, '.dork', 'data');
    expect(await pathExists(dataDir)).toBe(true);
    const dataEntries = await readdir(dataDir);
    expect(dataEntries.sort()).toEqual(['cache.bin', 'state.json']);
    const stateContent = await readFile(path.join(dataDir, 'state.json'), 'utf-8');
    expect(stateContent).toBe('{"foo":1}');
    const secretsContent = await readFile(path.join(installRoot, '.dork', 'secrets.json'), 'utf-8');
    expect(JSON.parse(secretsContent)).toEqual({ token: 'shh' });
    expect(result.preservedData).toEqual(
      expect.arrayContaining([
        path.join(installRoot, '.dork', 'data'),
        path.join(installRoot, '.dork', 'secrets.json'),
      ])
    );
  });

  it('removes everything including .dork/data and secrets when purge is true', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const installRoot = path.join(deps.dorkHome, 'plugins', 'purge-target');
    await stageInstalledPackage({
      installRoot,
      manifest: buildPluginManifest({ name: 'purge-target' }),
      dataFiles: [{ name: 'state.json', content: '{"foo":1}' }],
      secrets: { token: 'shh' },
    });

    const flow = new UninstallFlow(deps);
    const result = await flow.uninstall({ name: 'purge-target', purge: true });

    expect(result.ok).toBe(true);
    expect(result.preservedData).toEqual([]);
    expect(await pathExists(installRoot)).toBe(false);
  });

  it('throws PackageNotInstalledError when no package matches the name', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);

    const flow = new UninstallFlow(deps);
    await expect(flow.uninstall({ name: 'ghost-package' })).rejects.toThrow(
      PackageNotInstalledError
    );
    expect(deps.extensionManager.disable).not.toHaveBeenCalled();
    expect(deps.adapterManager.removeAdapter).not.toHaveBeenCalled();
  });

  it('rolls back from staging when extensionManager.disable throws mid-uninstall', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    deps.extensionManager.disable.mockRejectedValue(new Error('boom: extension disable failed'));
    const installRoot = path.join(deps.dorkHome, 'plugins', 'rollback-plugin');
    await stageInstalledPackage({
      installRoot,
      manifest: buildPluginManifest({ name: 'rollback-plugin', extensions: ['ext-x'] }),
      extensions: [{ id: 'ext-x', manifest: { id: 'ext-x' } }],
      dataFiles: [{ name: 'state.json', content: '{"keep":true}' }],
    });

    const flow = new UninstallFlow(deps);
    await expect(flow.uninstall({ name: 'rollback-plugin' })).rejects.toThrow(
      /boom: extension disable failed/
    );

    // Original package is intact (rollback restored from staging).
    expect(await pathExists(installRoot)).toBe(true);
    expect(await pathExists(path.join(installRoot, '.dork', 'manifest.json'))).toBe(true);
    expect(
      await pathExists(path.join(installRoot, '.dork', 'extensions', 'ext-x', 'extension.json'))
    ).toBe(true);
    expect(await pathExists(path.join(installRoot, '.dork', 'data', 'state.json'))).toBe(true);
  });
});
