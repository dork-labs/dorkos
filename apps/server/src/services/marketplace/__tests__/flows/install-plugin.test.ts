/**
 * Tests for {@link PluginInstallFlow}.
 *
 * Each test stages a minimal plugin package in a tmp directory, then drives
 * the flow with mocked extension compiler/manager dependencies. The five
 * cases below cover the success matrix (with and without bundled extensions,
 * global vs project-local) plus the two failure paths the flow must handle
 * by cleaning up its staging directory and never leaving the install root.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import type { PluginPackageManifest } from '@dorkos/marketplace';
import { PluginInstallFlow } from '../../flows/install-plugin.js';

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

/** Returns true if `target` exists as a symlink (does not follow it). */
async function isSymlinkAt(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isSymbolicLink();
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
  /** Written to `package.json` at the package root when supplied. */
  packageJson?: Record<string, unknown>;
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'install-plugin-pkg-'));
  await mkdir(path.join(root, '.dork'), { recursive: true });
  if (opts.packageJson) {
    await writeFile(path.join(root, 'package.json'), JSON.stringify(opts.packageJson), 'utf-8');
  }
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
  extensionManager: { enable: ReturnType<typeof vi.fn>; disable: ReturnType<typeof vi.fn> };
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
      disable: vi.fn().mockResolvedValue({ extension: {}, reloadRequired: true }),
    },
    logger: buildLogger(),
  };
}

describe('PluginInstallFlow', () => {
  const cleanupDirs: string[] = [];

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
    // A project-scoped plugin install is legitimate (unlike a project-scoped
    // Shape install, DOR-386) — it never carries a scope warning.
    expect(result.warnings).toEqual([]);
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

  it('overwrites a pre-existing install root and reaps the target backup on success', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const manifest = buildManifest({ name: 'overwrite-plugin' });
    const pkgPath = await stagePackage({ manifest });
    cleanupDirs.push(pkgPath);

    // A prior installation already occupies the target. The file-scoped engine
    // moves it aside, installs the new package, and deletes the backup.
    const installRoot = path.join(deps.dorkHome, 'plugins', 'overwrite-plugin');
    await mkdir(installRoot, { recursive: true });
    await writeFile(path.join(installRoot, 'old.txt'), 'previous version', 'utf-8');

    const flow = new PluginInstallFlow(deps);
    const result = await flow.install(pkgPath, manifest, {});

    expect(result.ok).toBe(true);
    // New package present, previous contents replaced.
    expect(await pathExists(path.join(installRoot, '.dork', 'manifest.json'))).toBe(true);
    expect(await pathExists(path.join(installRoot, 'old.txt'))).toBe(false);
    // No leftover backup sibling under plugins/.
    const pluginEntries = await readdir(path.join(deps.dorkHome, 'plugins'));
    expect(pluginEntries.some((e) => e.includes('.dorkos-bak-'))).toBe(false);

    const stagingPrefix = 'dorkos-install-install-plugin-overwrite-plugin-';
    const tmpEntries = await readdir(tmpdir());
    expect(tmpEntries.some((e) => e.startsWith(stagingPrefix))).toBe(false);
  });

  it('disables extensions the reinstalled version dropped and keeps the ones it retains', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const flow = new PluginInstallFlow(deps);

    // v1 ships ext-a and ext-b.
    const v1Manifest = buildManifest({
      name: 'drift-plugin',
      version: '1.0.0',
      extensions: ['ext-a', 'ext-b'],
    });
    const v1Pkg = await stagePackage({
      manifest: v1Manifest,
      extensions: [
        { id: 'ext-a', manifest: { id: 'ext-a', name: 'A', version: '1.0.0' } },
        { id: 'ext-b', manifest: { id: 'ext-b', name: 'B', version: '1.0.0' } },
      ],
    });
    cleanupDirs.push(v1Pkg);
    await flow.install(v1Pkg, v1Manifest, {});

    // Fresh install must not disable anything.
    expect(deps.extensionManager.disable).not.toHaveBeenCalled();
    expect(deps.extensionManager.enable.mock.calls.map((c) => c[0]).sort()).toEqual([
      'ext-a',
      'ext-b',
    ]);
    deps.extensionManager.enable.mockClear();

    // v2 drops ext-a and keeps ext-b.
    const v2Manifest = buildManifest({
      name: 'drift-plugin',
      version: '2.0.0',
      extensions: ['ext-b'],
    });
    const v2Pkg = await stagePackage({
      manifest: v2Manifest,
      extensions: [{ id: 'ext-b', manifest: { id: 'ext-b', name: 'B', version: '2.0.0' } }],
    });
    cleanupDirs.push(v2Pkg);
    await flow.install(v2Pkg, v2Manifest, {});

    // The dropped extension is disabled; the retained one is not.
    expect(deps.extensionManager.disable).toHaveBeenCalledTimes(1);
    expect(deps.extensionManager.disable).toHaveBeenCalledWith('ext-a');
    expect(deps.extensionManager.disable).not.toHaveBeenCalledWith('ext-b');
    // The retained extension is re-enabled against the new bundle.
    expect(deps.extensionManager.enable).toHaveBeenCalledWith('ext-b');

    // Only v2's extension remains on disk.
    const installedExtRoot = path.join(
      deps.dorkHome,
      'plugins',
      'drift-plugin',
      '.dork',
      'extensions'
    );
    const remaining = await readdir(installedExtRoot);
    expect(remaining.sort()).toEqual(['ext-b']);
  });

  it('does not fail a completed reinstall when disabling a dropped extension throws, and still processes the rest', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const flow = new PluginInstallFlow(deps);

    // v1 ships ext-a and ext-b.
    const v1Manifest = buildManifest({
      name: 'drop-fail-plugin',
      version: '1.0.0',
      extensions: ['ext-a', 'ext-b'],
    });
    const v1Pkg = await stagePackage({
      manifest: v1Manifest,
      extensions: [
        { id: 'ext-a', manifest: { id: 'ext-a', name: 'A', version: '1.0.0' } },
        { id: 'ext-b', manifest: { id: 'ext-b', name: 'B', version: '1.0.0' } },
      ],
    });
    cleanupDirs.push(v1Pkg);
    await flow.install(v1Pkg, v1Manifest, {});

    // The first dropped extension's teardown rejects (e.g. server shutdown throws).
    deps.extensionManager.disable.mockImplementation((id: string) =>
      id === 'ext-a'
        ? Promise.reject(new Error('boom: server teardown failed'))
        : Promise.resolve({ extension: {}, reloadRequired: true })
    );

    // v2 drops BOTH extensions.
    const v2Manifest = buildManifest({
      name: 'drop-fail-plugin',
      version: '2.0.0',
      extensions: [],
    });
    const v2Pkg = await stagePackage({ manifest: v2Manifest, extensions: [] });
    cleanupDirs.push(v2Pkg);

    // The disable runs AFTER the transaction committed, so a rejection must NOT
    // bubble out of install() — else the update path reports a live reinstall as
    // failed. And the loop must continue past the failing one.
    const result = await flow.install(v2Pkg, v2Manifest, {});
    expect(result.ok).toBe(true);
    expect(
      await pathExists(
        path.join(deps.dorkHome, 'plugins', 'drop-fail-plugin', '.dork', 'manifest.json')
      )
    ).toBe(true);
    expect(deps.extensionManager.disable.mock.calls.map((c) => c[0]).sort()).toEqual([
      'ext-a',
      'ext-b',
    ]);
  });

  it('strips escaping symlinks from a malicious package so the activated tree has no followable escape', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const manifest = buildManifest({ name: 'evil-plugin' });
    const pkgPath = await stagePackage({ manifest });
    cleanupDirs.push(pkgPath);

    // A malicious package ships two escaping symlinks: an absolute one pointing
    // at a system file and a relative one climbing out of the install root.
    await symlink('/etc/passwd', path.join(pkgPath, 'abs-escape'));
    await symlink('../../other-project', path.join(pkgPath, 'rel-escape'), 'dir');
    // Plus a legitimate regular file that must still land.
    await writeFile(path.join(pkgPath, 'real.txt'), 'legit', 'utf-8');

    const flow = new PluginInstallFlow(deps);
    const result = await flow.install(pkgPath, manifest, {});
    expect(result.ok).toBe(true);

    const installRoot = path.join(deps.dorkHome, 'plugins', 'evil-plugin');
    // Neither escaping link survives into the activated tree — not as a symlink,
    // not as any entry harness sync could follow out of the install root.
    for (const name of ['abs-escape', 'rel-escape']) {
      const p = path.join(installRoot, name);
      expect(await pathExists(p)).toBe(false);
      expect(await isSymlinkAt(p)).toBe(false);
    }
    // The legitimate file copied through untouched.
    expect(await readFile(path.join(installRoot, 'real.txt'), 'utf-8')).toBe('legit');
  });

  it('restores the previous install root when enabling an extension fails mid-activate', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    // enable() throws after the atomicMove has landed the new contents, forcing
    // the engine to remove the partial target and restore the backup.
    deps.extensionManager.enable.mockRejectedValue(new Error('boom: enable failed'));
    const manifest = buildManifest({ name: 'restore-plugin', extensions: ['x'] });
    const pkgPath = await stagePackage({
      manifest,
      extensions: [{ id: 'x', manifest: { id: 'x', name: 'X', version: '0.1.0' } }],
    });
    cleanupDirs.push(pkgPath);

    // Seed a distinctive prior installation.
    const installRoot = path.join(deps.dorkHome, 'plugins', 'restore-plugin');
    await mkdir(installRoot, { recursive: true });
    await writeFile(path.join(installRoot, 'original.txt'), 'ORIGINAL', 'utf-8');

    const flow = new PluginInstallFlow(deps);
    await expect(flow.install(pkgPath, manifest, {})).rejects.toThrow(/boom: enable failed/);

    // The original installation is restored byte-for-byte.
    expect(await pathExists(installRoot)).toBe(true);
    expect(await readFile(path.join(installRoot, 'original.txt'), 'utf-8')).toBe('ORIGINAL');
    // The new package's files are gone (the failed install left no residue).
    expect(await pathExists(path.join(installRoot, '.dork', 'extensions', 'x'))).toBe(false);
    // No leftover backup sibling.
    const pluginEntries = await readdir(path.join(deps.dorkHome, 'plugins'));
    expect(pluginEntries.some((e) => e.includes('.dorkos-bak-'))).toBe(false);
  });

  /**
   * npm dependency installation (DOR-1341), driven end to end against a stub
   * `npm` on `PATH` rather than an injected runner — the point of these tests is
   * that the flow really shells out and that what npm creates is activated onto
   * the install root by the same atomic move as the package files.
   *
   * Skipped on win32, where the stub would need a `.cmd` shim; the runner's own
   * unit tests (`lib/__tests__/npm-dependencies.test.ts`) carry the platform
   * argv assertion.
   */
  describe.skipIf(process.platform === 'win32')('npm dependencies', () => {
    /** Put an executable stub named `npm` at the front of `PATH`. */
    async function stubNpm(script: string): Promise<void> {
      const binDir = await mkdtemp(path.join(tmpdir(), 'install-plugin-npm-stub-'));
      cleanupDirs.push(binDir);
      const stub = path.join(binDir, 'npm');
      await writeFile(stub, script, 'utf-8');
      await chmod(stub, 0o755);
      vi.stubEnv('PATH', `${binDir}${path.delimiter}${process.env.PATH ?? ''}`);
    }

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('installs declared dependencies and activates node_modules onto the install root', async () => {
      // Stand in for a real registry fetch: create the one thing npm would.
      await stubNpm('#!/bin/sh\nmkdir -p node_modules/zod\necho ok > node_modules/zod/index.js\n');
      const deps = await buildDeps();
      cleanupDirs.push(deps.dorkHome);
      const manifest = buildManifest({ name: 'needs-zod' });
      const pkgPath = await stagePackage({
        manifest,
        packageJson: { name: 'needs-zod', dependencies: { zod: '^4.3.6' } },
      });
      cleanupDirs.push(pkgPath);

      const result = await new PluginInstallFlow(deps).install(pkgPath, manifest, {});

      expect(result.warnings).toEqual([]);
      const installRoot = path.join(deps.dorkHome, 'plugins', 'needs-zod');
      expect(await pathExists(path.join(installRoot, 'node_modules', 'zod', 'index.js'))).toBe(
        true
      );
    });

    it('never runs npm for a package that declares no runtime dependencies', async () => {
      const marker = path.join(await mkdtemp(path.join(tmpdir(), 'npm-marker-')), 'ran');
      cleanupDirs.push(path.dirname(marker));
      await stubNpm(`#!/bin/sh\ntouch "${marker}"\n`);
      const deps = await buildDeps();
      cleanupDirs.push(deps.dorkHome);
      const manifest = buildManifest({ name: 'dev-deps-only' });
      const pkgPath = await stagePackage({
        manifest,
        packageJson: { name: 'dev-deps-only', devDependencies: { zod: '^4.3.6' } },
      });
      cleanupDirs.push(pkgPath);

      const result = await new PluginInstallFlow(deps).install(pkgPath, manifest, {});

      expect(result.warnings).toEqual([]);
      expect(await pathExists(marker)).toBe(false);
    });

    it('still installs the package, with a warning, when npm fails', async () => {
      await stubNpm("#!/bin/sh\necho 'npm error code ENETUNREACH' >&2\nexit 1\n");
      const deps = await buildDeps();
      cleanupDirs.push(deps.dorkHome);
      const manifest = buildManifest({ name: 'npm-fails' });
      const pkgPath = await stagePackage({
        manifest,
        packageJson: { name: 'npm-fails', dependencies: { zod: '^4.3.6' } },
      });
      cleanupDirs.push(pkgPath);

      const result = await new PluginInstallFlow(deps).install(pkgPath, manifest, {});

      const installRoot = path.join(deps.dorkHome, 'plugins', 'npm-fails');
      expect(result.ok).toBe(true);
      expect(await pathExists(path.join(installRoot, '.dork', 'manifest.json'))).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('npm error code ENETUNREACH');
      expect(result.warnings[0]).toContain(installRoot);
    });

    it('leaves no node_modules behind when a later step in the transaction fails', async () => {
      // The whole reason npm runs on the STAGED tree: a rollback has to take
      // the vendored libraries with it. npm succeeds here; the extension enable
      // that follows does not, so the transaction unwinds a fresh install.
      await stubNpm('#!/bin/sh\nmkdir -p node_modules/zod\necho ok > node_modules/zod/index.js\n');
      const deps = await buildDeps();
      cleanupDirs.push(deps.dorkHome);
      deps.extensionManager.enable.mockRejectedValue(new Error('boom: enable failed'));
      const manifest = buildManifest({ name: 'rolls-back', extensions: ['hello-world'] });
      const pkgPath = await stagePackage({
        manifest,
        extensions: [
          { id: 'hello-world', manifest: { id: 'hello-world', name: 'H', version: '0.1.0' } },
        ],
        packageJson: { name: 'rolls-back', dependencies: { zod: '^4.3.6' } },
      });
      cleanupDirs.push(pkgPath);

      await expect(new PluginInstallFlow(deps).install(pkgPath, manifest, {})).rejects.toThrow(
        /enable failed/
      );

      const installRoot = path.join(deps.dorkHome, 'plugins', 'rolls-back');
      expect(await pathExists(path.join(installRoot, 'node_modules'))).toBe(false);
      expect(await pathExists(installRoot)).toBe(false);
    });

    it('still installs the package, with a warning, when npm is not on the machine', async () => {
      vi.stubEnv('PATH', path.join(tmpdir(), 'dorkos-no-npm-here'));
      const deps = await buildDeps();
      cleanupDirs.push(deps.dorkHome);
      const manifest = buildManifest({ name: 'no-npm' });
      const pkgPath = await stagePackage({
        manifest,
        packageJson: { name: 'no-npm', dependencies: { zod: '^4.3.6' } },
      });
      cleanupDirs.push(pkgPath);

      const result = await new PluginInstallFlow(deps).install(pkgPath, manifest, {});

      expect(result.ok).toBe(true);
      expect(await pathExists(path.join(deps.dorkHome, 'plugins', 'no-npm'))).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('npm is not installed');
    });
  });
});
