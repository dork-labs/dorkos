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
  ShapePackageManifest,
} from '@dorkos/marketplace';
import {
  PackageNotInstalledError,
  UninstallFlow,
  type UninstallShapeDeactivator,
  type UninstallShapeScheduleTeardown,
} from '../../flows/uninstall.js';
import { InvalidPackageNameError } from '../../lib/package-paths.js';

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

/** Build a minimal valid {@link ShapePackageManifest}. */
function buildShapeManifest(overrides: Partial<ShapePackageManifest> = {}): ShapePackageManifest {
  return {
    schemaVersion: 1,
    name: 'fixture-shape',
    version: '0.1.0',
    type: 'shape',
    description: 'Fixture shape used by uninstall tests.',
    tags: [],
    layers: [],
    requires: [],
    activates: [],
    extensions: [],
    layout: {},
    agents: [],
    schedules: [],
    connections: [],
    ...overrides,
  } as ShapePackageManifest;
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
  extensionManager: {
    disable: ReturnType<typeof vi.fn>;
    forgetRunApproval: ReturnType<typeof vi.fn>;
  };
  adapterManager: { removeAdapter: ReturnType<typeof vi.fn> };
  logger: Logger;
}> {
  const dorkHome = await mkdtemp(path.join(tmpdir(), 'uninstall-home-'));
  return {
    dorkHome,
    extensionManager: {
      disable: vi.fn().mockResolvedValue({ extension: {}, reloadRequired: true }),
      forgetRunApproval: vi.fn().mockResolvedValue(undefined),
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

  /**
   * A load approval is keyed to the extension id and does not expire (DOR-516), so
   * it has to be forgotten when the code behind that id goes away. Otherwise:
   * approve `foo` v1 once, then `marketplace_install` a different `foo` later —
   * tier `act`, always allowed, and `MarketplaceInstaller.update()` is documented
   * as an uninstall followed by a fresh install — and the new code runs with
   * nothing to click and nothing shown.
   */
  it('forgets the run approval for every extension a removed package bundled', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const installRoot = path.join(deps.dorkHome, 'plugins', 'plugin-approved');
    await stageInstalledPackage({
      installRoot,
      manifest: buildPluginManifest({ name: 'plugin-approved', extensions: ['ext-a', 'ext-b'] }),
      extensions: [
        { id: 'ext-a', manifest: { id: 'ext-a' } },
        { id: 'ext-b', manifest: { id: 'ext-b' } },
      ],
    });

    const flow = new UninstallFlow(deps);
    await flow.uninstall({ name: 'plugin-approved' });

    expect(deps.extensionManager.forgetRunApproval).toHaveBeenCalledTimes(2);
    expect(deps.extensionManager.forgetRunApproval).toHaveBeenCalledWith('ext-a');
    expect(deps.extensionManager.forgetRunApproval).toHaveBeenCalledWith('ext-b');
  });

  it('forgets it even when `purge` is false, because data is not consent', async () => {
    // `purge: false` is the update path's setting: it preserves `.dork/data/` and
    // `.dork/secrets.json` across the replace. Preserving a person's DATA across
    // new code is right; preserving their APPROVAL of the old code is not.
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const installRoot = path.join(deps.dorkHome, 'plugins', 'plugin-update');
    await stageInstalledPackage({
      installRoot,
      manifest: buildPluginManifest({ name: 'plugin-update', extensions: ['ext-a'] }),
      extensions: [{ id: 'ext-a', manifest: { id: 'ext-a' } }],
      dataFiles: [{ name: 'notes.json', content: '{"kept":true}' }],
    });

    const flow = new UninstallFlow(deps);
    const result = await flow.uninstall({ name: 'plugin-update', purge: false });

    expect(result.preservedData.length).toBeGreaterThan(0);
    expect(deps.extensionManager.forgetRunApproval).toHaveBeenCalledWith('ext-a');
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

  it('removes a Shape installed under shapes/ (DOR-355 regression)', async () => {
    // A Shape lives under `<dorkHome>/shapes/<name>`, a root the uninstall
    // probe originally never looked in — so uninstalling a Shape failed with
    // PackageNotInstalledError even though the install landed on disk.
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const installRoot = path.join(deps.dorkHome, 'shapes', 'linear-ops');
    await stageInstalledPackage({
      installRoot,
      manifest: buildShapeManifest({ name: 'linear-ops' }),
    });

    const flow = new UninstallFlow(deps);
    const result = await flow.uninstall({ name: 'linear-ops' });

    expect(result.ok).toBe(true);
    expect(result.packageName).toBe('linear-ops');
    expect(await pathExists(installRoot)).toBe(false);
    expect(deps.extensionManager.disable).not.toHaveBeenCalled();
    expect(deps.adapterManager.removeAdapter).not.toHaveBeenCalled();
  });

  it('clears the active Shape when the uninstalled Shape is the active one', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const installRoot = path.join(deps.dorkHome, 'shapes', 'linear-ops');
    await stageInstalledPackage({
      installRoot,
      manifest: buildShapeManifest({ name: 'linear-ops' }),
    });

    const clearActiveShape = vi.fn();
    const shapeDeactivator: UninstallShapeDeactivator = {
      getActiveShapeName: () => 'linear-ops',
      clearActiveShape,
    };

    const flow = new UninstallFlow({ ...deps, shapeDeactivator });
    await flow.uninstall({ name: 'linear-ops' });

    expect(clearActiveShape).toHaveBeenCalledTimes(1);
    expect(await pathExists(installRoot)).toBe(false);
  });

  it('keeps the active Shape when deactivateShape is false (installer update replace)', async () => {
    // The installer's update() runs uninstall as the first half of a replace —
    // the same Shape lands right back at the same path. Clearing
    // ui.shapes.active there would silently drop the cockpit to "no active
    // Shape" on every active-Shape update, so the internal flag suppresses
    // the deactivation side-effect.
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const installRoot = path.join(deps.dorkHome, 'shapes', 'linear-ops');
    await stageInstalledPackage({
      installRoot,
      manifest: buildShapeManifest({ name: 'linear-ops' }),
    });

    const clearActiveShape = vi.fn();
    const shapeDeactivator: UninstallShapeDeactivator = {
      getActiveShapeName: () => 'linear-ops',
      clearActiveShape,
    };

    const flow = new UninstallFlow({ ...deps, shapeDeactivator });
    await flow.uninstall({ name: 'linear-ops', deactivateShape: false });

    expect(clearActiveShape).not.toHaveBeenCalled();
    expect(await pathExists(installRoot)).toBe(false);
  });

  it('leaves the active Shape untouched when a different Shape is uninstalled', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const installRoot = path.join(deps.dorkHome, 'shapes', 'linear-ops');
    await stageInstalledPackage({
      installRoot,
      manifest: buildShapeManifest({ name: 'linear-ops' }),
    });

    const clearActiveShape = vi.fn();
    const shapeDeactivator: UninstallShapeDeactivator = {
      getActiveShapeName: () => 'some-other-shape',
      clearActiveShape,
    };

    const flow = new UninstallFlow({ ...deps, shapeDeactivator });
    await flow.uninstall({ name: 'linear-ops' });

    expect(clearActiveShape).not.toHaveBeenCalled();
    expect(await pathExists(installRoot)).toBe(false);
  });

  it("deletes the Shape's schedules AND disables its extensions when it is the active Shape", async () => {
    // Uninstalling the active Shape is full teardown: its schedules must stop
    // firing (the orphaned-schedule bug) and the extensions it turned on must
    // turn back off (the never-deactivated bug), then the active pointer clears.
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const installRoot = path.join(deps.dorkHome, 'shapes', 'linear-ops');
    await stageInstalledPackage({
      installRoot,
      manifest: buildShapeManifest({ name: 'linear-ops', activates: ['linear-issues', 'ext-2'] }),
    });

    const clearActiveShape = vi.fn();
    const shapeDeactivator: UninstallShapeDeactivator = {
      getActiveShapeName: () => 'linear-ops',
      clearActiveShape,
    };
    const deleteSchedulesForShape = vi.fn().mockResolvedValue(['inbox-tick']);
    const shapeScheduleTeardown: UninstallShapeScheduleTeardown = { deleteSchedulesForShape };

    const flow = new UninstallFlow({ ...deps, shapeDeactivator, shapeScheduleTeardown });
    await flow.uninstall({ name: 'linear-ops' });

    // Schedules torn down for this exact Shape.
    expect(deleteSchedulesForShape).toHaveBeenCalledWith('linear-ops');
    // Every extension the Shape declared `activates` is disabled.
    expect(deps.extensionManager.disable).toHaveBeenCalledWith('linear-issues');
    expect(deps.extensionManager.disable).toHaveBeenCalledWith('ext-2');
    expect(deps.extensionManager.disable).toHaveBeenCalledTimes(2);
    // Active pointer cleared.
    expect(clearActiveShape).toHaveBeenCalledTimes(1);
    expect(await pathExists(installRoot)).toBe(false);
  });

  it("deletes the Shape's schedules but leaves extensions + pointer when it is NOT active", async () => {
    // A different Shape is active. Its extensions may depend on the shared set,
    // so uninstalling a non-active Shape must not disable any extension or touch
    // the active pointer — but its own schedules are still torn down.
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const installRoot = path.join(deps.dorkHome, 'shapes', 'linear-ops');
    await stageInstalledPackage({
      installRoot,
      manifest: buildShapeManifest({ name: 'linear-ops', activates: ['linear-issues'] }),
    });

    const clearActiveShape = vi.fn();
    const shapeDeactivator: UninstallShapeDeactivator = {
      getActiveShapeName: () => 'some-other-shape',
      clearActiveShape,
    };
    const deleteSchedulesForShape = vi.fn().mockResolvedValue(['inbox-tick']);
    const shapeScheduleTeardown: UninstallShapeScheduleTeardown = { deleteSchedulesForShape };

    const flow = new UninstallFlow({ ...deps, shapeDeactivator, shapeScheduleTeardown });
    await flow.uninstall({ name: 'linear-ops' });

    // Schedules torn down regardless of active status.
    expect(deleteSchedulesForShape).toHaveBeenCalledWith('linear-ops');
    // Extensions + active pointer untouched.
    expect(deps.extensionManager.disable).not.toHaveBeenCalled();
    expect(clearActiveShape).not.toHaveBeenCalled();
    expect(await pathExists(installRoot)).toBe(false);
  });

  it('skips all Shape teardown on an update replace (deactivateShape: false)', async () => {
    // The installer update runs uninstall as the first half of a replace — the
    // Shape comes right back — so it must NOT delete schedules, disable
    // extensions, or clear the pointer.
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const installRoot = path.join(deps.dorkHome, 'shapes', 'linear-ops');
    await stageInstalledPackage({
      installRoot,
      manifest: buildShapeManifest({ name: 'linear-ops', activates: ['linear-issues'] }),
    });

    const clearActiveShape = vi.fn();
    const shapeDeactivator: UninstallShapeDeactivator = {
      getActiveShapeName: () => 'linear-ops',
      clearActiveShape,
    };
    const deleteSchedulesForShape = vi.fn().mockResolvedValue([]);
    const shapeScheduleTeardown: UninstallShapeScheduleTeardown = { deleteSchedulesForShape };

    const flow = new UninstallFlow({ ...deps, shapeDeactivator, shapeScheduleTeardown });
    await flow.uninstall({ name: 'linear-ops', deactivateShape: false });

    expect(deleteSchedulesForShape).not.toHaveBeenCalled();
    expect(deps.extensionManager.disable).not.toHaveBeenCalled();
    expect(clearActiveShape).not.toHaveBeenCalled();
    expect(await pathExists(installRoot)).toBe(false);
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

  describe('package-name traversal', () => {
    // The name reaches `path.join(dorkHome, dir, name)` and, one step later,
    // an atomicMove of whatever it found into a tmpdir that is then deleted.
    // A name that climbs therefore aims a recursive delete at any directory
    // the caller likes, so the flow refuses it before it touches disk at all.
    it.each([
      ['../../victim'],
      ['..'],
      ['a/../../../etc'],
      ['/etc'],
      ['..\\..\\windows'],
      ['pkg\0'],
    ])('refuses to uninstall %j and touches nothing on disk', async (name) => {
      const deps = await buildDeps();
      cleanupDirs.push(deps.dorkHome);
      // A real sibling of dorkHome that a `../` name would reach.
      const victim = path.join(path.dirname(deps.dorkHome), 'uninstall-victim');
      cleanupDirs.push(victim);
      await mkdir(victim, { recursive: true });
      await writeFile(path.join(victim, 'keep.txt'), 'still here', 'utf-8');

      const flow = new UninstallFlow(deps);
      await expect(flow.uninstall({ name })).rejects.toThrow(InvalidPackageNameError);

      expect(await pathExists(path.join(victim, 'keep.txt'))).toBe(true);
      expect(deps.extensionManager.disable).not.toHaveBeenCalled();
      expect(deps.adapterManager.removeAdapter).not.toHaveBeenCalled();
    });

    it('refuses a traversal name aimed at a project-local plugin root', async () => {
      const deps = await buildDeps();
      cleanupDirs.push(deps.dorkHome);
      const projectPath = await mkdtemp(path.join(tmpdir(), 'uninstall-project-'));
      cleanupDirs.push(projectPath);
      const victim = path.join(projectPath, 'src');
      await mkdir(victim, { recursive: true });
      await writeFile(path.join(victim, 'index.ts'), 'export {};', 'utf-8');

      const flow = new UninstallFlow(deps);
      await expect(flow.uninstall({ name: '../../src', projectPath })).rejects.toThrow(
        InvalidPackageNameError
      );

      expect(await pathExists(path.join(victim, 'index.ts'))).toBe(true);
    });
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

  // === Generated schedule cleanup (DOR-1487) =============================

  /**
   * Write an install receipt naming skill directories the install generated
   * outside the package's own install root.
   */
  async function writeReceipt(
    installRoot: string,
    generatedSchedulePaths: string[]
  ): Promise<void> {
    await mkdir(path.join(installRoot, '.dork'), { recursive: true });
    await writeFile(
      path.join(installRoot, '.dork', 'install-metadata.json'),
      JSON.stringify(
        {
          name: 'plugin-sched',
          version: '1.0.0',
          type: 'plugin',
          installedAt: new Date().toISOString(),
          generatedSchedulePaths,
        },
        null,
        2
      ),
      'utf-8'
    );
  }

  /** Create a skill directory with a SKILL.md at the given path. */
  async function makeSkillDir(dirPath: string, body = 'Body.'): Promise<void> {
    await mkdir(dirPath, { recursive: true });
    await writeFile(
      path.join(dirPath, 'SKILL.md'),
      `---\nname: ${path.basename(dirPath)}\ndescription: Generated.\n---\n\n${body}\n`,
      'utf-8'
    );
  }

  it('removes the skill directories the install generated for its schedules', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const projectPath = await mkdtemp(path.join(tmpdir(), 'uninstall-project-'));
    cleanupDirs.push(projectPath);

    const installRoot = path.join(deps.dorkHome, 'plugins', 'plugin-sched');
    await stageInstalledPackage({
      installRoot,
      manifest: buildPluginManifest({ name: 'plugin-sched' }),
    });

    const generated = [
      path.join(projectPath, '.agents', 'skills', 'nightly'),
      path.join(projectPath, '.agents', 'skills', 'weekly'),
    ];
    for (const dir of generated) await makeSkillDir(dir);
    await writeReceipt(installRoot, generated);

    const flow = new UninstallFlow(deps);
    const result = await flow.uninstall({ name: 'plugin-sched' });

    expect(result.ok).toBe(true);
    // A schedule must not keep firing for a package that is gone.
    for (const dir of generated) {
      expect(await pathExists(dir)).toBe(false);
    }
  });

  it("removes ONLY what the receipt names, never a neighbour's skill", async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const projectPath = await mkdtemp(path.join(tmpdir(), 'uninstall-project-'));
    cleanupDirs.push(projectPath);

    const installRoot = path.join(deps.dorkHome, 'plugins', 'plugin-sched');
    await stageInstalledPackage({
      installRoot,
      manifest: buildPluginManifest({ name: 'plugin-sched' }),
    });

    const ours = path.join(projectPath, '.agents', 'skills', 'ours');
    const theirs = path.join(projectPath, '.agents', 'skills', 'theirs');
    await makeSkillDir(ours);
    await makeSkillDir(theirs, 'A skill the person wrote.');
    await writeReceipt(installRoot, [ours]);

    const flow = new UninstallFlow(deps);
    await flow.uninstall({ name: 'plugin-sched' });

    expect(await pathExists(ours)).toBe(false);
    // Untouched: uninstall deletes from the receipt, never by scanning.
    expect(await pathExists(theirs)).toBe(true);
    expect(await readFile(path.join(theirs, 'SKILL.md'), 'utf-8')).toContain(
      'A skill the person wrote.'
    );
  });

  it('uninstalls cleanly when the receipt predates the field', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const installRoot = path.join(deps.dorkHome, 'plugins', 'plugin-sched');
    await stageInstalledPackage({
      installRoot,
      manifest: buildPluginManifest({ name: 'plugin-sched' }),
    });

    const flow = new UninstallFlow(deps);
    const result = await flow.uninstall({ name: 'plugin-sched' });

    expect(result.ok).toBe(true);
    expect(await pathExists(installRoot)).toBe(false);
  });

  it('still uninstalls when a generated directory cannot be removed', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const installRoot = path.join(deps.dorkHome, 'plugins', 'plugin-sched');
    await stageInstalledPackage({
      installRoot,
      manifest: buildPluginManifest({ name: 'plugin-sched' }),
    });
    // A path that was recorded and has since vanished — the ordinary case of a
    // cleanup that cannot complete. Failing here would restore a package the
    // person asked to remove, over a leftover file.
    await writeReceipt(installRoot, ['/nonexistent/definitely/not/here']);

    const flow = new UninstallFlow(deps);
    const result = await flow.uninstall({ name: 'plugin-sched' });

    expect(result.ok).toBe(true);
    expect(await pathExists(installRoot)).toBe(false);
  });
});
