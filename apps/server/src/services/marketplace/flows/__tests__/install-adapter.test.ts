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
import { ADAPTER_PROJECT_PATH_IGNORED_WARNING, AdapterInstallFlow } from '../install-adapter.js';

/** Build a no-op logger that records calls for assertion. */
function buildLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** A saved entry in the fake manager: the adapter type and its config. */
interface SavedEntry {
  type: string;
  config: Record<string, unknown>;
}

/**
 * Build a partial AdapterManager mock exposing the methods the install flow
 * touches, backed by a map of saved entries like the real one: `addAdapter`
 * refuses an id already saved (`DUPLICATE_ID`) and otherwise saves it,
 * `getAdapter` reads the map, and `removeAdapter` deletes from it. Pass
 * `saved` to start with connections that exist before the install. Cast
 * through `unknown` to satisfy the structural type without re-implementing
 * the entire class surface.
 */
function buildAdapterManagerMock(overrides?: {
  addAdapter?: ReturnType<typeof vi.fn>;
  removeAdapter?: ReturnType<typeof vi.fn>;
  saved?: Map<string, SavedEntry>;
}): AdapterManager {
  const saved = overrides?.saved ?? new Map<string, SavedEntry>();
  return {
    addAdapter:
      overrides?.addAdapter ??
      vi.fn(async (type: string, id: string, config: Record<string, unknown>) => {
        if (saved.has(id)) throw new Error(`Adapter with ID '${id}' already exists`);
        saved.set(id, { type, config });
      }),
    removeAdapter:
      overrides?.removeAdapter ??
      vi.fn(async (id: string) => {
        saved.delete(id);
      }),
    getAdapter: vi.fn((id: string) => {
      const entry = saved.get(id);
      return entry ? { config: { id, type: entry.type, config: entry.config } } : undefined;
    }),
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

    const result = await flow.install(packagePath, manifest, {});

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

  it('removes the entry it saved when the adapter then fails to start', async () => {
    const manifest = buildManifest('failing-adapter');
    const packagePath = await writeAdapterPackage(sourceRoot, manifest);
    const saved = new Map<string, SavedEntry>();
    // `addAdapter` saves the entry, then throws while starting it.
    const addAdapter = vi.fn(async (type: string, id: string, config: Record<string, unknown>) => {
      saved.set(id, { type, config });
      throw new Error('addAdapter exploded');
    });
    const adapterManager = buildAdapterManagerMock({ addAdapter, saved });
    const flow = new AdapterInstallFlow({ dorkHome, adapterManager, logger: buildLogger() });

    await expect(flow.install(packagePath, manifest, {})).rejects.toThrow('addAdapter exploded');

    expect(adapterManager.removeAdapter).toHaveBeenCalledTimes(1);
    expect(adapterManager.removeAdapter).toHaveBeenCalledWith(manifest.name);
    expect(saved.has(manifest.name)).toBe(false);
  });

  it('never removes a connection that already had the id (DOR-2607)', async () => {
    const manifest = buildManifest('taken-name');
    const packagePath = await writeAdapterPackage(sourceRoot, manifest);
    // The person's own connection, saved before the install ran.
    const saved = new Map<string, SavedEntry>([
      [manifest.name, { type: 'telegram', config: { token: 'theirs' } }],
    ]);
    const adapterManager = buildAdapterManagerMock({ saved });
    const flow = new AdapterInstallFlow({ dorkHome, adapterManager, logger: buildLogger() });

    await expect(flow.install(packagePath, manifest, {})).rejects.toThrow('already exists');

    expect(adapterManager.removeAdapter).not.toHaveBeenCalled();
    expect(saved.has(manifest.name)).toBe(true);
  });

  it('keeps the connection and its secrets when the same package is installed again', async () => {
    const manifest = buildManifest('reinstalled');
    const packagePath = await writeAdapterPackage(sourceRoot, manifest);
    const pluginPath = path.join(dorkHome, 'plugins', manifest.name, '.dork', 'adapters', 'slack');
    // Registered by the earlier install of this package, with its secret set since.
    const saved = new Map<string, SavedEntry>([
      [manifest.name, { type: 'slack', config: { pluginPath, botToken: 'kept' } }],
    ]);
    const adapterManager = buildAdapterManagerMock({ saved });
    const flow = new AdapterInstallFlow({ dorkHome, adapterManager, logger: buildLogger() });

    const result = await flow.install(packagePath, manifest, {});

    expect(result.ok).toBe(true);
    expect(adapterManager.addAdapter).not.toHaveBeenCalled();
    expect(adapterManager.removeAdapter).not.toHaveBeenCalled();
    expect(saved.get(manifest.name)).toEqual({
      type: 'slack',
      config: { pluginPath, botToken: 'kept' },
    });
  });

  it('still refuses a same-name connection of another type or path', async () => {
    const manifest = buildManifest('lookalike');
    const packagePath = await writeAdapterPackage(sourceRoot, manifest);
    const saved = new Map<string, SavedEntry>([
      [manifest.name, { type: 'slack', config: { pluginPath: '/somewhere/else' } }],
    ]);
    const adapterManager = buildAdapterManagerMock({ saved });
    const flow = new AdapterInstallFlow({ dorkHome, adapterManager, logger: buildLogger() });

    await expect(flow.install(packagePath, manifest, {})).rejects.toThrow('already exists');

    expect(adapterManager.addAdapter).toHaveBeenCalledTimes(1);
    expect(adapterManager.removeAdapter).not.toHaveBeenCalled();
    expect(saved.get(manifest.name)?.config).toEqual({ pluginPath: '/somewhere/else' });
  });

  it("never removes a person's connection saved under the id while the install was registering", async () => {
    const manifest = buildManifest('raced-name');
    const packagePath = await writeAdapterPackage(sourceRoot, manifest);
    const saved = new Map<string, SavedEntry>();
    // The id is free when the install starts. While `addAdapter` awaits, the
    // person saves their own connection under it, and the install then fails.
    const addAdapter = vi.fn(async (_type: string, id: string) => {
      saved.set(id, { type: 'telegram', config: { token: 'theirs' } });
      throw new Error(`Adapter with ID '${id}' already exists`);
    });
    const adapterManager = buildAdapterManagerMock({ addAdapter, saved });
    const flow = new AdapterInstallFlow({ dorkHome, adapterManager, logger: buildLogger() });

    await expect(flow.install(packagePath, manifest, {})).rejects.toThrow('already exists');

    expect(adapterManager.removeAdapter).not.toHaveBeenCalled();
    expect(saved.get(manifest.name)?.config).toEqual({ token: 'theirs' });
  });

  it('removes nothing when addAdapter refuses before saving', async () => {
    const manifest = buildManifest('unknown-type');
    const packagePath = await writeAdapterPackage(sourceRoot, manifest);
    const addAdapter = vi.fn().mockRejectedValue(new Error('Unknown adapter type: slack'));
    const adapterManager = buildAdapterManagerMock({ addAdapter });
    const flow = new AdapterInstallFlow({ dorkHome, adapterManager, logger: buildLogger() });

    await expect(flow.install(packagePath, manifest, {})).rejects.toThrow('Unknown adapter type');

    expect(adapterManager.removeAdapter).not.toHaveBeenCalled();
  });

  it('keeps delivery history when rolling back a failed install (DOR-2604)', async () => {
    const manifest = buildManifest('rollback-adapter');
    const packagePath = await writeAdapterPackage(sourceRoot, manifest);
    const removeAdapter = vi.fn().mockResolvedValue(undefined);
    const adapterManager = buildAdapterManagerMock({
      addAdapter: vi.fn().mockRejectedValue(new Error('addAdapter exploded')),
      removeAdapter,
    });
    const flow = new AdapterInstallFlow({ dorkHome, adapterManager, logger: buildLogger() });

    await expect(flow.install(packagePath, manifest, {})).rejects.toThrow('addAdapter exploded');

    // Only a person removing a connection passes `forgetHistory`.
    for (const call of removeAdapter.mock.calls) {
      expect(call[1]?.forgetHistory).not.toBe(true);
    }
  });

  it('returns warnings array containing the secret-configuration hint', async () => {
    const manifest = buildManifest('hint-adapter');
    const packagePath = await writeAdapterPackage(sourceRoot, manifest);
    const adapterManager = buildAdapterManagerMock();
    const flow = new AdapterInstallFlow({ dorkHome, adapterManager, logger: buildLogger() });

    const result = await flow.install(packagePath, manifest, {});

    expect(result.warnings).toEqual([
      'Configure secrets via dorkos relay-adapters set ' + manifest.name,
    ]);
    // No projectPath was requested, so there is nothing to warn about.
    expect(result.warnings).not.toContain(ADAPTER_PROJECT_PATH_IGNORED_WARNING);
  });

  it('warns that the project choice was ignored when the request carries a projectPath (DOR-1776)', async () => {
    // Adapters are global-only — the relay's adapter registry
    // (`relay-adapters.json`) has no per-project dimension. A caller (MCP tool,
    // HTTP route, CLI) that requests a project-scoped install must be told their
    // scope choice was ignored rather than have it silently dropped. Mirrors the
    // Shape flow's SHAPE_PROJECT_PATH_IGNORED_WARNING (DOR-386).
    const manifest = buildManifest('scoped-adapter');
    const packagePath = await writeAdapterPackage(sourceRoot, manifest);
    const adapterManager = buildAdapterManagerMock();
    const flow = new AdapterInstallFlow({ dorkHome, adapterManager, logger: buildLogger() });

    const result = await flow.install(packagePath, manifest, { projectPath: '/some/project' });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      ADAPTER_PROJECT_PATH_IGNORED_WARNING,
      'Configure secrets via dorkos relay-adapters set ' + manifest.name,
    ]);
    // The install root is unaffected — still global, never under projectPath.
    const installPath = path.join(dorkHome, 'plugins', 'scoped-adapter');
    expect(result.installPath).toBe(installPath);
    await access(path.join(installPath, '.dork', 'manifest.json'));
  });
});
