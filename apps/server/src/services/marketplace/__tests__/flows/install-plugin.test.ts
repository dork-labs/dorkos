/**
 * Tests for {@link PluginInstallFlow}.
 *
 * Each test stages a minimal plugin package in a tmp directory, then drives
 * the flow with mocked extension compiler/manager dependencies. The five
 * cases below cover the success matrix (with and without bundled extensions,
 * global vs project-local) plus the two failure paths the flow must handle
 * by cleaning up its staging directory and never leaving the install root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import type { PluginPackageManifest } from '@dorkos/marketplace';
import { PluginInstallFlow } from '../../flows/install-plugin.js';
import { _internal as transactionInternal } from '../../transaction.js';

/** Construct a no-op logger that satisfies the {@link Logger} interface. */
function buildLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Build a minimal valid {@link PluginPackageManifest} with sensible defaults. */
function buildManifest(overrides: Partial<PluginPackageManifest> = {}): PluginPackageManifest {
  return {
    schemaVersion: 1,
    name: 'fixture-plugin',
    version: '0.1.0',
    type: 'plugin',
    description: 'Fixture plugin used by install-plugin tests.',
    tags: [],
    layers: [],
    requires: [],
    extensions: [],
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
 * Stage a fake plugin package on disk. Returns the absolute path to the
 * package root. The caller is responsible for removing it.
 */
async function stagePackage(opts: {
  manifest: PluginPackageManifest;
  extensions?: { id: string; manifest: Record<string, unknown> }[];
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'install-plugin-pkg-'));
  await mkdir(path.join(root, '.dork'), { recursive: true });
  await writeFile(
    path.join(root, '.dork', 'manifest.json'),
    JSON.stringify(opts.manifest, null, 2),
    'utf-8'
  );

  for (const ext of opts.extensions ?? []) {
    const extDir = path.join(root, '.dork', 'extensions', ext.id);
    await mkdir(extDir, { recursive: true });
    await writeFile(
      path.join(extDir, 'extension.json'),
      JSON.stringify(ext.manifest, null, 2),
      'utf-8'
    );
    await writeFile(path.join(extDir, 'index.ts'), 'export const activate = () => {};', 'utf-8');
  }

  return root;
}

/** Build a deps object with mock compiler + manager spies and a tmp dorkHome. */
async function buildDeps(): Promise<{
  dorkHome: string;
  extensionCompiler: { compile: ReturnType<typeof vi.fn> };
  extensionManager: { enable: ReturnType<typeof vi.fn> };
  logger: Logger;
}> {
  const dorkHome = await mkdtemp(path.join(tmpdir(), 'install-plugin-home-'));
  return {
    dorkHome,
    extensionCompiler: {
      compile: vi.fn().mockResolvedValue({ code: 'compiled', sourceHash: 'abc123' }),
    },
    extensionManager: {
      enable: vi.fn().mockResolvedValue({ extension: {}, reloadRequired: true }),
    },
    logger: buildLogger(),
  };
}

describe('PluginInstallFlow', () => {
  const cleanupDirs: string[] = [];

  beforeEach(() => {
    // CRITICAL: prevent runTransaction from doing real `git reset --hard` against
    // the live worktree. The transaction engine's failure-path rollback would
    // otherwise wipe uncommitted tracked-file changes during test runs.
    vi.spyOn(transactionInternal, 'isGitRepo').mockResolvedValue(false);
  });

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('installs a plugin with no extensions and writes package files to installRoot', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const manifest = buildManifest({ name: 'no-ext-plugin' });
    const pkgPath = await stagePackage({ manifest });
    cleanupDirs.push(pkgPath);

    const flow = new PluginInstallFlow(deps);
    const result = await flow.install(pkgPath, manifest, {});

    expect(result.ok).toBe(true);
    expect(result.packageName).toBe('no-ext-plugin');
    expect(result.type).toBe('plugin');
    const installRoot = path.join(deps.dorkHome, 'plugins', 'no-ext-plugin');
    expect(result.installPath).toBe(installRoot);
    expect(await pathExists(installRoot)).toBe(true);
    expect(await pathExists(path.join(installRoot, '.dork', 'manifest.json'))).toBe(true);
    expect(deps.extensionCompiler.compile).not.toHaveBeenCalled();
    expect(deps.extensionManager.enable).not.toHaveBeenCalled();
  });

  it('compiles and enables every bundled extension on a successful install', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const manifest = buildManifest({ name: 'with-ext-plugin', extensions: ['hello-world'] });
    const pkgPath = await stagePackage({
      manifest,
      extensions: [
        {
          id: 'hello-world',
          manifest: { id: 'hello-world', name: 'Hello', version: '0.1.0' },
        },
      ],
    });
    cleanupDirs.push(pkgPath);

    const flow = new PluginInstallFlow(deps);
    const result = await flow.install(pkgPath, manifest, {});

    expect(result.ok).toBe(true);
    expect(deps.extensionCompiler.compile).toHaveBeenCalledTimes(1);
    expect(deps.extensionManager.enable).toHaveBeenCalledWith('hello-world');
    const installedExt = path.join(
      deps.dorkHome,
      'plugins',
      'with-ext-plugin',
      '.dork',
      'extensions',
      'hello-world'
    );
    expect(await pathExists(installedExt)).toBe(true);
  });

  it('places project-local installs under projectPath/.dork/plugins/<name>', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const projectPath = await mkdtemp(path.join(tmpdir(), 'install-plugin-proj-'));
    cleanupDirs.push(projectPath);
    const manifest = buildManifest({ name: 'local-plugin' });
    const pkgPath = await stagePackage({ manifest });
    cleanupDirs.push(pkgPath);

    const flow = new PluginInstallFlow(deps);
    const result = await flow.install(pkgPath, manifest, { projectPath });

    const expected = path.join(projectPath, '.dork', 'plugins', 'local-plugin');
    expect(result.installPath).toBe(expected);
    expect(await pathExists(expected)).toBe(true);
    // The global root must NOT be touched for a project-local install.
    expect(await pathExists(path.join(deps.dorkHome, 'plugins', 'local-plugin'))).toBe(false);
  });

  it('rolls back staging and skips installRoot when extension compilation throws', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    deps.extensionCompiler.compile.mockRejectedValue(new Error('boom: esbuild crashed'));
    const manifest = buildManifest({ name: 'broken-plugin', extensions: ['broken-ext'] });
    const pkgPath = await stagePackage({
      manifest,
      extensions: [
        {
          id: 'broken-ext',
          manifest: { id: 'broken-ext', name: 'Broken', version: '0.1.0' },
        },
      ],
    });
    cleanupDirs.push(pkgPath);

    const flow = new PluginInstallFlow(deps);
    await expect(flow.install(pkgPath, manifest, {})).rejects.toThrow(/boom: esbuild crashed/);

    expect(await pathExists(path.join(deps.dorkHome, 'plugins', 'broken-plugin'))).toBe(false);
    expect(deps.extensionManager.enable).not.toHaveBeenCalled();

    // No leftover staging directories from this transaction.
    const stagingPrefix = 'dorkos-install-install-plugin-broken-plugin-';
    const tmpEntries = await readdir(tmpdir());
    expect(tmpEntries.some((e) => e.startsWith(stagingPrefix))).toBe(false);
  });

  it('rolls back staging when the activation rename fails', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const manifest = buildManifest({ name: 'rename-fail-plugin' });
    const pkgPath = await stagePackage({ manifest });
    cleanupDirs.push(pkgPath);

    // Create the install root as a file so fs.rename + fs.cp both fail.
    const installRoot = path.join(deps.dorkHome, 'plugins', 'rename-fail-plugin');
    await mkdir(path.dirname(installRoot), { recursive: true });
    await writeFile(installRoot, 'blocking file', 'utf-8');

    const flow = new PluginInstallFlow(deps);
    await expect(flow.install(pkgPath, manifest, {})).rejects.toThrow();

    // The blocking file is still there — we never overwrote it.
    const blockingStat = await stat(installRoot);
    expect(blockingStat.isFile()).toBe(true);

    const stagingPrefix = 'dorkos-install-install-plugin-rename-fail-plugin-';
    const tmpEntries = await readdir(tmpdir());
    expect(tmpEntries.some((e) => e.startsWith(stagingPrefix))).toBe(false);
  });
});
