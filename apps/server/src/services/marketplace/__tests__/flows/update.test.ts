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
 * its `dork-package.json` (plus an optional `installedFrom` field that the
 * discovery walker picks up when present).
 */
async function stageInstalledPlugin(opts: {
  dorkHome: string;
  manifest: PluginPackageManifest;
  installedFrom?: string;
}): Promise<string> {
  const installRoot = path.join(opts.dorkHome, 'plugins', opts.manifest.name);
  await mkdir(installRoot, { recursive: true });
  const raw: Record<string, unknown> = { ...opts.manifest };
  if (opts.installedFrom !== undefined) {
    raw.installedFrom = opts.installedFrom;
  }
  await writeFile(
    path.join(installRoot, 'dork-package.json'),
    JSON.stringify(raw, null, 2),
    'utf-8'
  );
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
  installer: { install: ReturnType<typeof vi.fn> };
  fetcher: { fetchMarketplaceJson: ReturnType<typeof vi.fn> };
  sourceManager: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
}> {
  const dorkHome = await mkdtemp(path.join(tmpdir(), 'update-flow-home-'));
  const installer: InstallerLike = {
    install: vi.fn(async (req) =>
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
    installer: installer as { install: ReturnType<typeof vi.fn> },
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
    expect(ctx.installer.install).not.toHaveBeenCalled();
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
    expect(ctx.installer.install).not.toHaveBeenCalled();
  });

  it('invokes installer.install with force when apply is true and an update exists', async () => {
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
    expect(ctx.installer.install).toHaveBeenCalledTimes(1);
    expect(ctx.installer.install).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'outdated-plugin',
        marketplace: 'fixture-marketplace',
        force: true,
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
    expect(ctx.installer.install).not.toHaveBeenCalled();
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
});
