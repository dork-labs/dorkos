/**
 * Tests for the adapter install flow.
 *
 * Builds a fixture adapter package on disk under a temp dorkHome, runs
 * `AdapterInstallFlow.install`, and asserts the staged contents land at
 * `${dorkHome}/plugins/${name}` and that `adapterManager.addAdapter` is
 * invoked with the correct shape. Also exercises the compensating
 * `removeAdapter` rollback when `addAdapter` fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import type { AdapterPackageManifest } from '@dorkos/marketplace';
import type { AdapterManager } from '../../../relay/adapter-manager.js';
import { AdapterInstallFlow } from '../../flows/install-adapter.js';

/** Build a no-op logger that records calls for assertion. */
function buildLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Build a partial AdapterManager mock exposing the two methods the
 * install flow touches. Cast through `unknown` to satisfy the structural
 * type without re-implementing the entire class surface.
 */
function buildAdapterManagerMock(overrides?: {
  addAdapter?: ReturnType<typeof vi.fn>;
  removeAdapter?: ReturnType<typeof vi.fn>;
}): AdapterManager {
  return {
    addAdapter: overrides?.addAdapter ?? vi.fn().mockResolvedValue(undefined),
    removeAdapter: overrides?.removeAdapter ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as AdapterManager;
}

/** Build a valid AdapterPackageManifest for the slack fixture. */
function buildManifest(name = 'valid-adapter'): AdapterPackageManifest {
  return {
    schemaVersion: 1,
    name,
    version: '1.0.0',
    type: 'adapter',
    adapterType: 'slack',
    description: 'A valid adapter fixture for the Slack relay backend',
    tags: [],
    layers: ['adapters'],
    requires: [],
  } as AdapterPackageManifest;
}

/**
 * Materialise a minimal valid adapter package on disk so the flow can
 * `fs.cp` it into staging and verify the layout post-install.
 */
async function writeAdapterPackage(
  root: string,
  manifest: AdapterPackageManifest
): Promise<string> {
  const pkgDir = path.join(root, manifest.name);
  await mkdir(path.join(pkgDir, '.dork', 'adapters', manifest.adapterType), { recursive: true });
  await writeFile(path.join(pkgDir, '.dork', 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(
    path.join(pkgDir, '.dork', 'adapters', manifest.adapterType, 'manifest.json'),
    JSON.stringify(
      { name: manifest.adapterType, version: manifest.version, entry: './index.ts' },
      null,
      2
    )
  );
  await writeFile(
    path.join(pkgDir, '.dork', 'adapters', manifest.adapterType, 'index.ts'),
    'export default {};\n'
  );
  return pkgDir;
}

describe('AdapterInstallFlow', () => {
  let dorkHome: string;
  let sourceRoot: string;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkhome-adapter-install-'));
    sourceRoot = await mkdtemp(path.join(tmpdir(), 'adapter-source-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dorkHome, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  });

  it('copies the package to plugins/<name> and registers it via addAdapter', async () => {
    const manifest = buildManifest();
    const packagePath = await writeAdapterPackage(sourceRoot, manifest);
    const adapterManager = buildAdapterManagerMock();
    const flow = new AdapterInstallFlow({ dorkHome, adapterManager, logger: buildLogger() });

    const result = await flow.install(packagePath, manifest, { name: manifest.name });

    const expectedInstallPath = path.join(dorkHome, 'plugins', manifest.name);
    expect(result.ok).toBe(true);
    expect(result.packageName).toBe(manifest.name);
    expect(result.version).toBe(manifest.version);
    expect(result.type).toBe('adapter');
    expect(result.installPath).toBe(expectedInstallPath);
    expect(result.manifest).toEqual(manifest);
    expect(result.warnings).toContain(
      'Configure secrets via dorkos relay-adapters set ' + manifest.name
    );
    // No backup branch since rollbackBranch: false
    expect(result.rollbackBranch).toBeUndefined();

    // Files landed at the install path
    await access(path.join(expectedInstallPath, '.dork', 'manifest.json'));
    const persistedManifest = JSON.parse(
      await readFile(path.join(expectedInstallPath, '.dork', 'manifest.json'), 'utf-8')
    );
    expect(persistedManifest.name).toBe(manifest.name);

    // adapterManager.addAdapter called with the real (positional) signature
    const addAdapterMock = adapterManager.addAdapter as unknown as ReturnType<typeof vi.fn>;
    expect(addAdapterMock).toHaveBeenCalledTimes(1);
    expect(addAdapterMock).toHaveBeenCalledWith(
      manifest.adapterType,
      manifest.name,
      expect.any(Object)
    );
  });

  it('compensates by calling removeAdapter when addAdapter throws', async () => {
    const manifest = buildManifest('failing-adapter');
    const packagePath = await writeAdapterPackage(sourceRoot, manifest);
    const addAdapter = vi.fn().mockRejectedValue(new Error('addAdapter exploded'));
    const removeAdapter = vi.fn().mockResolvedValue(undefined);
    const adapterManager = buildAdapterManagerMock({ addAdapter, removeAdapter });
    const flow = new AdapterInstallFlow({ dorkHome, adapterManager, logger: buildLogger() });

    await expect(flow.install(packagePath, manifest, { name: manifest.name })).rejects.toThrow(
      'addAdapter exploded'
    );

    // Compensating removeAdapter must have been called for the failed instance
    expect(removeAdapter).toHaveBeenCalledTimes(1);
    expect(removeAdapter).toHaveBeenCalledWith(manifest.name);
  });

  it('returns warnings array containing the secret-configuration hint', async () => {
    const manifest = buildManifest('hint-adapter');
    const packagePath = await writeAdapterPackage(sourceRoot, manifest);
    const adapterManager = buildAdapterManagerMock();
    const flow = new AdapterInstallFlow({ dorkHome, adapterManager, logger: buildLogger() });

    const result = await flow.install(packagePath, manifest, { name: manifest.name });

    expect(result.warnings).toEqual([
      'Configure secrets via dorkos relay-adapters set ' + manifest.name,
    ]);
  });
});
