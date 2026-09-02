/**
 * Tests for {@link UpdateFlow}.
 *
 * The update flow is advisory by default — it enumerates installed packages,
 * compares their versions to the latest marketplace entry, and returns a
 * list of {@link UpdateCheckResult} describing what could be updated.
 * Only when `apply: true` does it invoke the injected installer to actually
 * perform the reinstall.
 *
 * Each test stages a handcrafted installed package on disk under a temp
 * `dorkHome`, then drives `UpdateFlow.run()` with mocked
 * installer/fetcher/sourceManager dependencies. The seven cases below cover
 * the three advisory scenarios (no update, has update, missing package error),
 * the apply flow (single package + multi-package), and the marketplace
 * resolution branches (scoped via `installedFrom`, fallback scan).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import type { MarketplaceJson, PluginPackageManifest } from '@dorkos/marketplace';
import {
  PackageNotInstalledForUpdateError,
  UpdateFlow,
  type InstallerLike,
  type UpdateFlowDeps,
} from '../../flows/update.js';
import type { InstallResult, MarketplaceSource } from '../../types.js';

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
    description: 'Fixture plugin used by update tests.',
    tags: [],
    layers: [],
    requires: [],
    extensions: [],
    ...overrides,
  };
}

/**
 * Stage an installed package on disk under `<dorkHome>/plugins/<name>/` with
 * its canonical `.dork/manifest.json` and an optional
 * `.dork/install-metadata.json` sidecar (read by the update flow's
 * provenance lookup when present).
 */
async function stageInstalledPlugin(opts: {
  dorkHome: string;
  manifest: PluginPackageManifest;
  installedFrom?: string;
}): Promise<string> {
  return stagePluginUnder(path.join(opts.dorkHome, 'plugins'), opts);
}

/**
 * Stage a project-scoped plugin under `<projectPath>/.dork/plugins/<name>/` —
 * exactly where `PluginInstallFlow.computeInstallRoot` lands an install that
 * carried a `projectPath`.
 */
async function stageProjectPlugin(opts: {
  projectPath: string;
  manifest: PluginPackageManifest;
  installedFrom?: string;
}): Promise<string> {
  return stagePluginUnder(path.join(opts.projectPath, '.dork', 'plugins'), opts);
}

/**
 * Stage an installed agent package under `<scopeRoot>/agents/<name>/` — the
 * root `AgentInstallFlow` lands an agent in, and a different root from the
 * plugin stagers above, so the two can hold the same package name at once.
 *
 * The update flow reads a manifest shallowly (name/version/type, no schema
 * validation), so this minimal document is exactly what it consumes.
 */
async function stageInstalledAgent(opts: {
  scopeRoot: string;
  name: string;
  version: string;
}): Promise<string> {
  const installRoot = path.join(opts.scopeRoot, 'agents', opts.name);
  await mkdir(path.join(installRoot, '.dork'), { recursive: true });
  await writeFile(
    path.join(installRoot, '.dork', 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        name: opts.name,
        version: opts.version,
        type: 'agent',
        description: 'Fixture agent used by update tests.',
      },
      null,
      2
    ),
    'utf-8'
  );
  return installRoot;
}

/**
 * Write a package's `.dork/manifest.json` (plus optional
 * `.dork/install-metadata.json` sidecar) into `<root>/<name>/`. Shared by the
 * global and project-scoped stagers so both produce byte-identical layouts.
 */
async function stagePluginUnder(
  root: string,
  opts: { manifest: PluginPackageManifest; installedFrom?: string }
): Promise<string> {
  const installRoot = path.join(root, opts.manifest.name);
  await mkdir(path.join(installRoot, '.dork'), { recursive: true });
  await writeFile(
    path.join(installRoot, '.dork', 'manifest.json'),
    JSON.stringify(opts.manifest, null, 2),
    'utf-8'
  );
  if (opts.installedFrom !== undefined) {
    await writeFile(
      path.join(installRoot, '.dork', 'install-metadata.json'),
      JSON.stringify(
        {
          name: opts.manifest.name,
          version: opts.manifest.version,
          type: opts.manifest.type,
          installedFrom: opts.installedFrom,
          installedAt: '2025-01-01T00:00:00.000Z',
        },
        null,
        2
      ),
      'utf-8'
    );
  }
  return installRoot;
}

/** Build a minimal {@link MarketplaceJson} document with a single entry. */
function buildMarketplaceJson(
  entries: Array<{ name: string; version?: string; source?: string }>
): MarketplaceJson {
  return {
    name: 'fixture-marketplace',
    plugins: entries.map((entry) => ({
      name: entry.name,
      source: entry.source ?? `https://example.com/${entry.name}`,
      version: entry.version,
    })),
  };
}

/** Build a {@link MarketplaceSource} descriptor. */
function buildSource(overrides: Partial<MarketplaceSource> = {}): MarketplaceSource {
  return {
    name: 'fixture-marketplace',
    source: 'https://example.com/marketplace',
    enabled: true,
    addedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Build an {@link InstallResult} suitable for returning from a mocked installer. */
function buildInstallResult(name: string, version: string, installPath: string): InstallResult {
  return {
    ok: true,
    packageName: name,
    version,
    type: 'plugin',
    installPath,
    manifest: buildPluginManifest({ name, version }),
    warnings: [],
  };
}

/**
 * Build a deps object with mock installer, fetcher, and source manager. The
 * caller supplies the marketplace document each fetcher call should yield.
 */
async function buildDeps(opts: {
  marketplaceJson: MarketplaceJson;
  sources?: MarketplaceSource[];
}): Promise<{
  deps: UpdateFlowDeps;
  dorkHome: string;
  installer: { update: ReturnType<typeof vi.fn> };
  fetcher: { fetchMarketplaceJson: ReturnType<typeof vi.fn> };
  sourceManager: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
}> {
  const dorkHome = await mkdtemp(path.join(tmpdir(), 'update-flow-home-'));
  const installer: InstallerLike = {
    update: vi.fn(async (req) =>
      buildInstallResult(req.name, '2.0.0', path.join(dorkHome, 'plugins', req.name))
    ),
  };
  const sources = opts.sources ?? [buildSource()];
  const fetcher = {
    fetchMarketplaceJson: vi.fn(async () => opts.marketplaceJson),
  };
  const sourceManager = {
    list: vi.fn(async () => sources),
    get: vi.fn(async (name: string) => sources.find((s) => s.name === name) ?? null),
  };

  const deps: UpdateFlowDeps = {
    dorkHome,
    installer,
    sourceManager,
    fetcher,
    logger: buildLogger(),
  };

  return {
    deps,
    dorkHome,
    installer: installer as { update: ReturnType<typeof vi.fn> },
    fetcher,
    sourceManager,
  };
}

describe('UpdateFlow', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('reports no update available when installed version matches latest', async () => {
    const marketplaceJson = buildMarketplaceJson([{ name: 'stable-plugin', version: '1.0.0' }]);
    const ctx = await buildDeps({ marketplaceJson });
    cleanupDirs.push(ctx.dorkHome);
    await stageInstalledPlugin({
      dorkHome: ctx.dorkHome,
      manifest: buildPluginManifest({ name: 'stable-plugin', version: '1.0.0' }),
    });

    const flow = new UpdateFlow(ctx.deps);
    const result = await flow.run({ name: 'stable-plugin' });

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toEqual(
      expect.objectContaining({
        packageName: 'stable-plugin',
        installedVersion: '1.0.0',
        latestVersion: '1.0.0',
        hasUpdate: false,
      })
    );
    expect(result.applied).toHaveLength(0);
    expect(ctx.installer.update).not.toHaveBeenCalled();
  });

  // The manifest is read off disk with no schema validation, and the name it
  // yields is handed to `installer.update()` — which uninstalls by name, and
  // joins that name into dorkHome. The directory entry name is the honest
  // fallback: it is a real directory that was actually walked, so it cannot
  // climb anywhere.
  it('falls back to the directory name when the manifest name is not a package name', async () => {
    const marketplaceJson = buildMarketplaceJson([{ name: 'honest-plugin', version: '2.0.0' }]);
    const ctx = await buildDeps({ marketplaceJson });
    cleanupDirs.push(ctx.dorkHome);
    const installRoot = path.join(ctx.dorkHome, 'plugins', 'honest-plugin');
    await mkdir(path.join(installRoot, '.dork'), { recursive: true });
    await writeFile(
      path.join(installRoot, '.dork', 'manifest.json'),
      JSON.stringify({
        ...buildPluginManifest({ name: 'honest-plugin', version: '1.0.0' }),
        name: '../../../../etc/cron.d',
      }),
      'utf-8'
    );

    const flow = new UpdateFlow(ctx.deps);
    const result = await flow.run({ apply: true });

    expect(result.checks[0]?.packageName).toBe('honest-plugin');
    expect(ctx.installer.update).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'honest-plugin' })
    );
  });

  it('reports update available but does not install in advisory mode', async () => {
    const marketplaceJson = buildMarketplaceJson([{ name: 'outdated-plugin', version: '2.0.0' }]);
    const ctx = await buildDeps({ marketplaceJson });
    cleanupDirs.push(ctx.dorkHome);
    await stageInstalledPlugin({
      dorkHome: ctx.dorkHome,
      manifest: buildPluginManifest({ name: 'outdated-plugin', version: '1.0.0' }),
    });

    const flow = new UpdateFlow(ctx.deps);
    const result = await flow.run({ name: 'outdated-plugin' });

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toEqual(
      expect.objectContaining({
        packageName: 'outdated-plugin',
        installedVersion: '1.0.0',
        latestVersion: '2.0.0',
        hasUpdate: true,
        marketplace: 'fixture-marketplace',
      })
    );
    expect(result.applied).toHaveLength(0);
    expect(ctx.installer.update).not.toHaveBeenCalled();
  });

  it('invokes installer.update when apply is true and an update exists', async () => {
    const marketplaceJson = buildMarketplaceJson([{ name: 'outdated-plugin', version: '2.0.0' }]);
    const ctx = await buildDeps({ marketplaceJson });
    cleanupDirs.push(ctx.dorkHome);
    await stageInstalledPlugin({
      dorkHome: ctx.dorkHome,
      manifest: buildPluginManifest({ name: 'outdated-plugin', version: '1.0.0' }),
    });

    const flow = new UpdateFlow(ctx.deps);
    const result = await flow.run({ name: 'outdated-plugin', apply: true });

    expect(result.checks[0]?.hasUpdate).toBe(true);
    expect(ctx.installer.update).toHaveBeenCalledTimes(1);
    expect(ctx.installer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'outdated-plugin',
        marketplace: 'fixture-marketplace',
      })
    );
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.packageName).toBe('outdated-plugin');
  });

  it('does not call installer.install when apply is true but nothing needs updating', async () => {
    const marketplaceJson = buildMarketplaceJson([{ name: 'stable-plugin', version: '1.0.0' }]);
    const ctx = await buildDeps({ marketplaceJson });
    cleanupDirs.push(ctx.dorkHome);
    await stageInstalledPlugin({
      dorkHome: ctx.dorkHome,
      manifest: buildPluginManifest({ name: 'stable-plugin', version: '1.0.0' }),
    });

    const flow = new UpdateFlow(ctx.deps);
    const result = await flow.run({ name: 'stable-plugin', apply: true });

    expect(result.checks[0]?.hasUpdate).toBe(false);
    expect(ctx.installer.update).not.toHaveBeenCalled();
    expect(result.applied).toHaveLength(0);
  });

  it('returns checks for every installed package when no name is supplied', async () => {
    const marketplaceJson = buildMarketplaceJson([
      { name: 'alpha', version: '1.1.0' },
      { name: 'beta', version: '2.0.0' },
    ]);
    const ctx = await buildDeps({ marketplaceJson });
    cleanupDirs.push(ctx.dorkHome);
    await stageInstalledPlugin({
      dorkHome: ctx.dorkHome,
      manifest: buildPluginManifest({ name: 'alpha', version: '1.0.0' }),
    });
    await stageInstalledPlugin({
      dorkHome: ctx.dorkHome,
      manifest: buildPluginManifest({ name: 'beta', version: '2.0.0' }),
    });

    const flow = new UpdateFlow(ctx.deps);
    const result = await flow.run({});

    expect(result.checks).toHaveLength(2);
    const alpha = result.checks.find((c) => c.packageName === 'alpha');
    const beta = result.checks.find((c) => c.packageName === 'beta');
    expect(alpha?.hasUpdate).toBe(true);
    expect(alpha?.latestVersion).toBe('1.1.0');
    expect(beta?.hasUpdate).toBe(false);
  });

  it('never lists a crash-left install backup, even with a valid manifest (DOR-175)', async () => {
    // A crash mid-install leaves `<name>.dorkos-bak-<ts>-<uuid>` beside the
    // real installation — a byte-for-byte move-aside carrying a valid manifest
    // under the same package name. Without the exclusion, update-all would see
    // a phantom duplicate and could target the backup path with an apply.
    const marketplaceJson = buildMarketplaceJson([{ name: 'alpha', version: '2.0.0' }]);
    const ctx = await buildDeps({ marketplaceJson });
    cleanupDirs.push(ctx.dorkHome);
    const realRoot = await stageInstalledPlugin({
      dorkHome: ctx.dorkHome,
      manifest: buildPluginManifest({ name: 'alpha', version: '1.0.0' }),
    });
    // Stage the backup sibling exactly as the transaction engine names it.
    const backupRoot = path.join(
      ctx.dorkHome,
      'plugins',
      `alpha.dorkos-bak-${Date.now()}-3fa85f64-5717-4562-b3fc-2c963f66afa6`
    );
    await mkdir(path.join(backupRoot, '.dork'), { recursive: true });
    await writeFile(
      path.join(backupRoot, '.dork', 'manifest.json'),
      JSON.stringify(buildPluginManifest({ name: 'alpha', version: '0.9.0' }), null, 2),
      'utf-8'
    );

    const flow = new UpdateFlow(ctx.deps);
    const result = await flow.run({ apply: true });

    // Exactly one check — the backup never became a phantom second package.
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toEqual(
      expect.objectContaining({ packageName: 'alpha', installedVersion: '1.0.0', hasUpdate: true })
    );
    // The single apply targeted the real package, not the backup path.
    expect(ctx.installer.update).toHaveBeenCalledTimes(1);
    expect(ctx.installer.update).toHaveBeenCalledWith(expect.objectContaining({ name: 'alpha' }));
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.installPath).toBe(realRoot);
  });

  it('throws PackageNotInstalledForUpdateError when a named package is missing', async () => {
    const marketplaceJson = buildMarketplaceJson([{ name: 'anything', version: '1.0.0' }]);
    const ctx = await buildDeps({ marketplaceJson });
    cleanupDirs.push(ctx.dorkHome);

    const flow = new UpdateFlow(ctx.deps);
    await expect(flow.run({ name: 'ghost-plugin' })).rejects.toBeInstanceOf(
      PackageNotInstalledForUpdateError
    );
  });

  it('uses the installedFrom marketplace when present instead of scanning all sources', async () => {
    const scopedSource = buildSource({ name: 'scoped-marketplace' });
    const otherSource = buildSource({
      name: 'other-marketplace',
      source: 'https://other.example.com/marketplace',
    });
    const scopedJson = buildMarketplaceJson([{ name: 'scoped-plugin', version: '3.0.0' }]);
    const otherJson = buildMarketplaceJson([{ name: 'scoped-plugin', version: '9.9.9' }]);

    const ctx = await buildDeps({
      marketplaceJson: scopedJson,
      sources: [scopedSource, otherSource],
    });
    cleanupDirs.push(ctx.dorkHome);

    ctx.fetcher.fetchMarketplaceJson.mockImplementation(async (source: MarketplaceSource) => {
      if (source.name === 'scoped-marketplace') return scopedJson;
      return otherJson;
    });

    await stageInstalledPlugin({
      dorkHome: ctx.dorkHome,
      manifest: buildPluginManifest({ name: 'scoped-plugin', version: '1.0.0' }),
      installedFrom: 'scoped-marketplace',
    });

    const flow = new UpdateFlow(ctx.deps);
    const result = await flow.run({ name: 'scoped-plugin' });

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.marketplace).toBe('scoped-marketplace');
    expect(result.checks[0]?.latestVersion).toBe('3.0.0');
    // Only the scoped marketplace was queried — no fallback scan.
    expect(ctx.fetcher.fetchMarketplaceJson).toHaveBeenCalledTimes(1);
    expect(ctx.fetcher.fetchMarketplaceJson).toHaveBeenCalledWith(scopedSource);
  });

  it('falls back to scanning all enabled sources when installedFrom is absent', async () => {
    const sourceA = buildSource({ name: 'marketplace-a' });
    const sourceB = buildSource({
      name: 'marketplace-b',
      source: 'https://b.example.com/marketplace',
    });
    const emptyJson = buildMarketplaceJson([]);
    const hitJson = buildMarketplaceJson([{ name: 'lost-plugin', version: '5.0.0' }]);

    const ctx = await buildDeps({
      marketplaceJson: hitJson,
      sources: [sourceA, sourceB],
    });
    cleanupDirs.push(ctx.dorkHome);

    ctx.fetcher.fetchMarketplaceJson.mockImplementation(async (source: MarketplaceSource) => {
      if (source.name === 'marketplace-a') return emptyJson;
      return hitJson;
    });

    await stageInstalledPlugin({
      dorkHome: ctx.dorkHome,
      manifest: buildPluginManifest({ name: 'lost-plugin', version: '4.0.0' }),
    });

    const flow = new UpdateFlow(ctx.deps);
    const result = await flow.run({ name: 'lost-plugin' });

    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.marketplace).toBe('marketplace-b');
    expect(result.checks[0]?.latestVersion).toBe('5.0.0');
    expect(result.checks[0]?.hasUpdate).toBe(true);
    // Both marketplaces were scanned.
    expect(ctx.fetcher.fetchMarketplaceJson).toHaveBeenCalledTimes(2);
  });

  describe('project-scoped installs', () => {
    /** Make a temp directory standing in for a caller's `projectPath`. */
    async function makeProjectDir(): Promise<string> {
      const dir = await mkdtemp(path.join(tmpdir(), 'update-flow-project-'));
      cleanupDirs.push(dir);
      return dir;
    }

    it('finds a package installed only in the project when projectPath is supplied', async () => {
      const marketplaceJson = buildMarketplaceJson([{ name: 'local-plugin', version: '2.0.0' }]);
      const ctx = await buildDeps({ marketplaceJson });
      cleanupDirs.push(ctx.dorkHome);
      const projectPath = await makeProjectDir();
      await stageProjectPlugin({
        projectPath,
        manifest: buildPluginManifest({ name: 'local-plugin', version: '1.0.0' }),
      });

      const flow = new UpdateFlow(ctx.deps);
      const result = await flow.run({ name: 'local-plugin', projectPath });

      expect(result.checks).toHaveLength(1);
      expect(result.checks[0]).toEqual(
        expect.objectContaining({
          packageName: 'local-plugin',
          installedVersion: '1.0.0',
          latestVersion: '2.0.0',
          hasUpdate: true,
        })
      );
    });

    it('still throws when the package is in neither scope', async () => {
      const marketplaceJson = buildMarketplaceJson([{ name: 'anything', version: '1.0.0' }]);
      const ctx = await buildDeps({ marketplaceJson });
      cleanupDirs.push(ctx.dorkHome);
      const projectPath = await makeProjectDir();

      const flow = new UpdateFlow(ctx.deps);
      await expect(flow.run({ name: 'ghost-plugin', projectPath })).rejects.toBeInstanceOf(
        PackageNotInstalledForUpdateError
      );
    });

    it('finds a global-only package when projectPath is supplied — the project scan adds, never replaces', async () => {
      const marketplaceJson = buildMarketplaceJson([{ name: 'global-plugin', version: '3.0.0' }]);
      const ctx = await buildDeps({ marketplaceJson });
      cleanupDirs.push(ctx.dorkHome);
      const projectPath = await makeProjectDir();
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'global-plugin', version: '1.0.0' }),
      });

      const flow = new UpdateFlow(ctx.deps);
      const result = await flow.run({ name: 'global-plugin', projectPath });

      expect(result.checks).toHaveLength(1);
      expect(result.checks[0]?.installedVersion).toBe('1.0.0');
    });

    it('resolves a name installed in both scopes to the project copy when projectPath is supplied', async () => {
      const marketplaceJson = buildMarketplaceJson([{ name: 'both-plugin', version: '9.0.0' }]);
      const ctx = await buildDeps({ marketplaceJson });
      cleanupDirs.push(ctx.dorkHome);
      const projectPath = await makeProjectDir();
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'both-plugin', version: '1.0.0' }),
      });
      const projectRoot = await stageProjectPlugin({
        projectPath,
        manifest: buildPluginManifest({ name: 'both-plugin', version: '2.0.0' }),
      });

      const flow = new UpdateFlow(ctx.deps);
      const result = await flow.run({ name: 'both-plugin', projectPath });

      expect(result.checks).toHaveLength(1);
      // The project copy (2.0.0) shadows the global one (1.0.0) for this project.
      expect(result.checks[0]?.installedVersion).toBe('2.0.0');
      expect(projectRoot).toContain(path.join('.dork', 'plugins'));
    });

    it('resolves the same name to the global copy when no projectPath is supplied', async () => {
      const marketplaceJson = buildMarketplaceJson([{ name: 'both-plugin', version: '9.0.0' }]);
      const ctx = await buildDeps({ marketplaceJson });
      cleanupDirs.push(ctx.dorkHome);
      const projectPath = await makeProjectDir();
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'both-plugin', version: '1.0.0' }),
      });
      await stageProjectPlugin({
        projectPath,
        manifest: buildPluginManifest({ name: 'both-plugin', version: '2.0.0' }),
      });

      const flow = new UpdateFlow(ctx.deps);
      const result = await flow.run({ name: 'both-plugin' });

      expect(result.checks).toHaveLength(1);
      expect(result.checks[0]?.installedVersion).toBe('1.0.0');
    });

    it('checks a name installed in both scopes once, so an applied update reinstalls once', async () => {
      const marketplaceJson = buildMarketplaceJson([{ name: 'both-plugin', version: '9.0.0' }]);
      const ctx = await buildDeps({ marketplaceJson });
      cleanupDirs.push(ctx.dorkHome);
      const projectPath = await makeProjectDir();
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'both-plugin', version: '1.0.0' }),
      });
      await stageProjectPlugin({
        projectPath,
        manifest: buildPluginManifest({ name: 'both-plugin', version: '2.0.0' }),
      });

      const flow = new UpdateFlow(ctx.deps);
      const result = await flow.run({ apply: true, projectPath });

      expect(result.checks).toHaveLength(1);
      expect(result.checks[0]?.installedVersion).toBe('2.0.0');
      expect(ctx.installer.update).toHaveBeenCalledTimes(1);
      expect(ctx.installer.update).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'both-plugin', projectPath })
      );
    });

    it('reports both roots when one name is installed as a plugin AND an agent globally', async () => {
      // `ConflictDetector` lets a same-name package of a different type coexist
      // in the other root (a non-blocking warning, not an error), so these are
      // two genuinely different packages. Deduping on the name alone would drop
      // one of them from update-all — and each resolves its own marketplace.
      const marketplaceJson = buildMarketplaceJson([{ name: 'twin', version: '9.0.0' }]);
      const ctx = await buildDeps({ marketplaceJson });
      cleanupDirs.push(ctx.dorkHome);
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'twin', version: '1.0.0' }),
      });
      await stageInstalledAgent({ scopeRoot: ctx.dorkHome, name: 'twin', version: '1.5.0' });

      const flow = new UpdateFlow(ctx.deps);
      const result = await flow.run({});

      expect(result.checks).toHaveLength(2);
      expect(result.checks.map((c) => c.installedVersion).sort()).toEqual(['1.0.0', '1.5.0']);
      expect(result.checks.every((c) => c.packageName === 'twin')).toBe(true);
    });

    it('shadows only the matching root: project plugin wins, global agent survives', async () => {
      const marketplaceJson = buildMarketplaceJson([{ name: 'twin', version: '9.0.0' }]);
      const ctx = await buildDeps({ marketplaceJson });
      cleanupDirs.push(ctx.dorkHome);
      const projectPath = await makeProjectDir();
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'twin', version: '1.0.0' }),
      });
      await stageInstalledAgent({ scopeRoot: ctx.dorkHome, name: 'twin', version: '1.5.0' });
      await stageProjectPlugin({
        projectPath,
        manifest: buildPluginManifest({ name: 'twin', version: '2.0.0' }),
      });

      const flow = new UpdateFlow(ctx.deps);
      const result = await flow.run({ projectPath });

      // The project's plugins/twin shadows the global plugins/twin (1.0.0 is
      // gone), while the global agents/twin is a different root and survives.
      expect(result.checks).toHaveLength(2);
      expect(result.checks.map((c) => c.installedVersion).sort()).toEqual(['1.5.0', '2.0.0']);
    });

    it('skips an unreadable project manifest, mirroring the global walk', async () => {
      const marketplaceJson = buildMarketplaceJson([{ name: 'broken-plugin', version: '2.0.0' }]);
      const ctx = await buildDeps({ marketplaceJson });
      cleanupDirs.push(ctx.dorkHome);
      const projectPath = await makeProjectDir();
      const brokenRoot = path.join(projectPath, '.dork', 'plugins', 'broken-plugin', '.dork');
      await mkdir(brokenRoot, { recursive: true });
      await writeFile(path.join(brokenRoot, 'manifest.json'), '{ not json', 'utf-8');

      const flow = new UpdateFlow(ctx.deps);
      const result = await flow.run({ projectPath });

      expect(result.checks).toHaveLength(0);
      await expect(flow.run({ name: 'broken-plugin', projectPath })).rejects.toBeInstanceOf(
        PackageNotInstalledForUpdateError
      );
    });
  });
});
