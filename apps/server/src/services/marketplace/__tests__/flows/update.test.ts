/**
 * Tests for {@link UpdateFlow}.
 *
 * The update flow is advisory by default: it enumerates installed packages,
 * asks the installer what installing each one now would give
 * (`resolveLatest`), compares by Claude Code's version chain, and returns one
 * {@link UpdateCheckResult} per package with an honest status. Only
 * `applyPlan`, handed the disclosures a person approved, reinstalls
 * (`applyAsShown` plays that person).
 *
 * Each test stages a handcrafted installed package on disk under a temp
 * `dorkHome`, then drives `UpdateFlow.run()` with mocked installer, fetcher
 * and source manager. The marketplace entries carry NO `version` by default,
 * because that is the shape `dork-labs/marketplace` actually publishes (the
 * old suite set one everywhere, and passed against a shape nobody ships).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import { applyAsShown } from '../apply-as-shown.js';
import { packageContentHash } from '../../lib/content-hash.js';
import type { MarketplaceJson, PluginPackageManifest, SourceKey } from '@dorkos/marketplace';
import { UPDATE_CHECK_CONCURRENCY, UPDATE_MEMO_TTL_MS, UpdateFlow } from '../../flows/update.js';
import {
  PackageNotInstalledForUpdateError,
  pickInstallation,
  selectInstallations,
} from '../../flows/update-selection.js';
import type {
  InstallationUpdateCheck,
  InstallerLike,
  UpdateCheckResult,
  UpdateFlowDeps,
} from '../../flows/update-types.js';
import type { InstallMetadata } from '../../installed-metadata.js';
import { scanInstallationRecords } from '../../installed-scanner.js';
import type {
  InstallRequest,
  InstallResult,
  LatestResolution,
  MarketplaceSource,
  PermissionPreview,
  ResolveLatestOptions,
} from '../../types.js';
import { disclosedEffectsOf } from '../../disclosed-effects.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

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

/** What a staged install carries on disk besides its files. */
interface StageOptions {
  /** `.dork/manifest.json`; `null` for a Claude-Code-only install with none. */
  manifest: PluginPackageManifest | null;
  /** Directory name; defaults to the manifest's name. */
  dirName?: string;
  /** `.claude-plugin/plugin.json`, when the install ships one. */
  pluginJson?: Record<string, unknown>;
  /** Shortcut for `metadata.installedFrom`. */
  installedFrom?: string;
  /** Extra `.dork/install-metadata.json` fields; a sidecar is written when either is set. */
  metadata?: Partial<InstallMetadata>;
}

/** Stage an install under `<dorkHome>/plugins/<name>/`. */
async function stageInstalledPlugin(opts: StageOptions & { dorkHome: string }): Promise<string> {
  return stagePluginUnder(path.join(opts.dorkHome, 'plugins'), opts);
}

/**
 * Stage a project-scoped plugin under `<projectPath>/.dork/plugins/<name>/` —
 * exactly where `PluginInstallFlow.computeInstallRoot` lands an install that
 * carried a `projectPath`.
 */
async function stageProjectPlugin(opts: StageOptions & { projectPath: string }): Promise<string> {
  return stagePluginUnder(path.join(opts.projectPath, '.dork', 'plugins'), opts);
}

/**
 * Stage an installed agent package under `<scopeRoot>/agents/<name>/` — the
 * root `AgentInstallFlow` lands an agent in, and a different root from the
 * plugin stagers above, so the two can hold the same package name at once.
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
    JSON.stringify({
      schemaVersion: 1,
      name: opts.name,
      version: opts.version,
      type: 'agent',
      description: 'Fixture agent used by update tests.',
    }),
    'utf-8'
  );
  return installRoot;
}

/** Write an install's files into `<root>/<name>/`. */
async function stagePluginUnder(root: string, opts: StageOptions): Promise<string> {
  const name = opts.dirName ?? opts.manifest?.name ?? String(opts.pluginJson?.name);
  const installRoot = path.join(root, name);
  await mkdir(path.join(installRoot, '.dork'), { recursive: true });
  if (opts.manifest) {
    await writeFile(
      path.join(installRoot, '.dork', 'manifest.json'),
      JSON.stringify(opts.manifest, null, 2),
      'utf-8'
    );
  }
  if (opts.pluginJson) {
    await mkdir(path.join(installRoot, '.claude-plugin'), { recursive: true });
    await writeFile(
      path.join(installRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify(opts.pluginJson),
      'utf-8'
    );
  }
  if (opts.installedFrom !== undefined || opts.metadata !== undefined) {
    await writeFile(
      path.join(installRoot, '.dork', 'install-metadata.json'),
      JSON.stringify({
        name,
        version: opts.manifest?.version ?? '0.0.0',
        type: 'plugin',
        installedAt: '2025-01-01T00:00:00.000Z',
        ...(opts.installedFrom !== undefined && { installedFrom: opts.installedFrom }),
        ...opts.metadata,
      }),
      'utf-8'
    );
  }
  return installRoot;
}

/**
 * Build a {@link MarketplaceJson}. Entries set no `version` unless a test
 * asks for one — our real marketplace's shape.
 */
function buildMarketplaceJson(entries: Array<{ name: string; version?: string }>): MarketplaceJson {
  return {
    name: 'fixture-marketplace',
    plugins: entries.map((entry) => ({
      name: entry.name,
      source: `https://example.com/${entry.name}`,
      ...(entry.version !== undefined && { version: entry.version }),
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

/** The fake installer's answer to `resolveLatest`. */
type ResolveLatestImpl = (
  req: InstallRequest,
  opts: ResolveLatestOptions
) => Promise<LatestResolution>;

/**
 * Build a deps object with mock installer, fetcher, and source manager.
 * `latest` maps a package name to the version its staged tree declares; a
 * test that needs another answer passes `resolveLatest`.
 */
async function buildDeps(opts: {
  marketplaceJson: MarketplaceJson;
  sources?: MarketplaceSource[];
  latest?: Record<string, string>;
  resolveLatest?: ResolveLatestImpl;
  now?: () => number;
}): Promise<{
  deps: UpdateFlowDeps;
  dorkHome: string;
  installer: {
    update: ReturnType<typeof vi.fn>;
    resolveLatest: ReturnType<typeof vi.fn<ResolveLatestImpl>>;
    preview: ReturnType<
      typeof vi.fn<
        (req: InstallRequest) => Promise<{ preview: PermissionPreview; packagePath: string }>
      >
    >;
  };
  fetcher: {
    fetchMarketplaceJson: ReturnType<typeof vi.fn>;
    lookupCommitSha: ReturnType<typeof vi.fn>;
  };
  sourceManager: { list: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
}> {
  const dorkHome = await mkdtemp(path.join(tmpdir(), 'update-flow-home-'));
  const resolveLatest = vi.fn<ResolveLatestImpl>(
    opts.resolveLatest ??
      (async (req) => ({ kind: 'resolved', declaredVersion: opts.latest?.[req.name] }))
  );
  const installer = {
    update: vi.fn(async (req: InstallRequest) =>
      buildInstallResult(req.name, '2.0.0', path.join(dorkHome, 'plugins', req.name))
    ),
    resolveLatest,
    // Staged into a real (empty) directory: a check hashes the staged files.
    preview: vi.fn(async (_req: InstallRequest) => ({
      preview: buildEmptyPreview(),
      packagePath: dorkHome,
    })),
  } satisfies InstallerLike;
  const sources = opts.sources ?? [buildSource()];
  const fetcher = {
    fetchMarketplaceJson: vi.fn(async () => opts.marketplaceJson),
    lookupCommitSha: vi.fn(async () => SHA_A),
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
    ...(opts.now && { now: opts.now }),
  };

  return { deps, dorkHome, installer, fetcher, sourceManager };
}

/** A preview that declares nothing, which a test overrides one field of. */
function buildEmptyPreview(overrides: Partial<PermissionPreview> = {}): PermissionPreview {
  return {
    fileChanges: [],
    extensions: [],
    hooks: [],
    unreadableHooks: [],
    mcpServers: [],
    lspServers: [],
    monitors: [],
    executables: [],
    skillTools: [],
    unreadableDeclarations: [],
    schedules: [],
    secrets: [],
    npmDependencies: [],
    externalHosts: [],
    requires: [],
    conflicts: [],
    ...overrides,
  };
}

/** A fake `resolveLatest` that consults the memoized commit lookup, as the real one does. */
function lookingUp(ref = 'main', answer: LatestResolution = { kind: 'unchanged' }) {
  return async (_req: InstallRequest, opts: ResolveLatestOptions): Promise<LatestResolution> => {
    try {
      await opts.commitLookup('https://example.com/marketplace', ref);
    } catch (err) {
      return { kind: 'unresolved', reason: (err as Error).message };
    }
    return answer;
  };
}

/**
 * Check one package by name the way the per-package route does: scan the
 * request's scope and check the installation the name means. With `apply`,
 * that one installation is applied the only way the flow allows
 * ({@link applyAsShown}), as a named `marketplace_update` would.
 */
async function runNamed(
  flow: UpdateFlow,
  dorkHome: string,
  req: { name: string; apply?: boolean; projectPath?: string }
): Promise<{ checks: UpdateCheckResult[]; applied: InstallResult[] }> {
  const inScope = await scanInstallationRecords(
    dorkHome,
    req.projectPath ? { projectPath: req.projectPath } : { agents: [] }
  );
  const installation = pickInstallation(inScope, req.name);
  if (req.apply && installation) return applyAsShown(flow, [installation]);
  const { checks } = await flow.run({ name: req.name, installation });
  return { checks, applied: [] };
}

/**
 * Check every installation in view through the all-packages door, the way the
 * route does: one scan, handed to `planInstallations`. With `apply`, every
 * stale one is applied held to what its check disclosed ({@link applyAsShown}).
 */
async function checkAll(
  flow: UpdateFlow,
  dorkHome: string,
  opts: { apply?: boolean; projectPath?: string } = {}
): Promise<{ checks: InstallationUpdateCheck[]; applied: InstallResult[] }> {
  const installations = await scanInstallationRecords(
    dorkHome,
    opts.projectPath ? { projectPath: opts.projectPath } : { agents: [] }
  );
  if (opts.apply) return applyAsShown(flow, installations);
  const { checks } = await flow.planInstallations({ installations });
  return { checks, applied: [] };
}

/** Every result keeps `hasUpdate` a pure function of `status`. */
function expectConsistent(checks: UpdateCheckResult[]): void {
  for (const check of checks) {
    expect(check.hasUpdate).toBe(check.status === 'update-available');
  }
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

  /** Build deps and register the temp dorkHome for cleanup. */
  async function setup(opts: Parameters<typeof buildDeps>[0]) {
    const ctx = await buildDeps(opts);
    cleanupDirs.push(ctx.dorkHome);
    return ctx;
  }

  describe('finding a new version', () => {
    it("detects an update from the package's own version when the entry sets none", async () => {
      // Purpose: the original DOR-2244 bug. With no entry version the old
      // check fell back to the installed version and said "up to date" forever.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'flow' }]),
        latest: { flow: '0.7.3' },
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'flow', version: '0.7.2' }),
      });

      const result = await runNamed(new UpdateFlow(ctx.deps), ctx.dorkHome, { name: 'flow' });

      expect(result.checks).toEqual([
        {
          packageName: 'flow',
          installedVersion: '0.7.2',
          latestVersion: '0.7.3',
          hasUpdate: true,
          marketplace: 'fixture-marketplace',
          status: 'update-available',
          installedVersionSource: 'package',
          latestVersionSource: 'package',
        },
      ]);
      expect(ctx.installer.update).not.toHaveBeenCalled();
    });

    it('lists and checks an install whose version files disagree, at the version Claude Code runs', async () => {
      // Purpose: flow's installs today carry manifest 0.6.0 beside plugin.json
      // 0.7.2. They must be checked (never gated on validity) as 0.7.2.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'flow' }]),
        latest: { flow: '0.7.3' },
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'flow', version: '0.6.0' }),
        pluginJson: { name: 'flow', version: '0.7.2' },
      });

      const [check] = (await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome)).checks;

      expect(check).toMatchObject({
        installedVersion: '0.7.2',
        latestVersion: '0.7.3',
        status: 'update-available',
      });
    });

    it('checks a Claude-Code-only install that has no .dork/manifest.json', async () => {
      // Purpose: 8 of 14 dork-labs/marketplace packages ship no manifest; the
      // old reader could not see them, so they were never checked.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'code-reviewer' }]),
        latest: { 'code-reviewer': '1.1.0' },
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: null,
        pluginJson: { name: 'code-reviewer', version: '1.0.0' },
      });

      const result = await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome);

      expect(result.checks).toHaveLength(1);
      expect(result.checks[0]).toMatchObject({
        packageName: 'code-reviewer',
        installedVersion: '1.0.0',
        latestVersion: '1.1.0',
        status: 'update-available',
      });
    });

    it('compares a package that declares no version by commit, reporting full SHAs', async () => {
      // Purpose: Claude Code's step 3. The SHA, not a masking 0.0.0, is the version.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'unversioned' }]),
        resolveLatest: async () => ({ kind: 'resolved', commitSha: SHA_B }),
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: null,
        pluginJson: { name: 'unversioned' },
        installedFrom: 'fixture-marketplace',
        metadata: { commitSha: SHA_A },
      });

      const [check] = (await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome)).checks;

      expect(check).toMatchObject({
        installedVersion: SHA_A,
        latestVersion: SHA_B,
        installedVersionSource: 'commit',
        latestVersionSource: 'commit',
        status: 'update-available',
      });
    });

    it('never offers a rollback as an update', async () => {
      // Purpose: a lower version in the marketplace is reported as current,
      // with a note, rather than presented as an improvement.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'pkg' }]),
        latest: { pkg: '1.1.0' },
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'pkg', version: '1.2.0' }),
      });

      const [check] = (await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome)).checks;

      expect(check).toMatchObject({ status: 'current', hasUpdate: false, latestVersion: '1.1.0' });
      expect(check?.note).toMatch(/^rollback: /);
    });

    it('reports current when the latest version equals the installed one', async () => {
      // Purpose: equal semver is current, with no note.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'stable-plugin' }]),
        latest: { 'stable-plugin': '1.0.0' },
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'stable-plugin', version: '1.0.0' }),
      });

      const [check] = (
        await runNamed(new UpdateFlow(ctx.deps), ctx.dorkHome, { name: 'stable-plugin' })
      ).checks;

      expect(check).toMatchObject({ status: 'current', latestVersion: '1.0.0' });
      expect(check?.note).toBeUndefined();
    });

    it('reports current, without staging, when the installer says nothing changed', async () => {
      // Purpose: the short-circuit answer maps to current, and apply leaves it alone.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'pkg' }]),
        resolveLatest: async () => ({ kind: 'unchanged' }),
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'pkg', version: '1.0.0' }),
      });

      const result = await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome, { apply: true });

      expect(result.checks[0]).toMatchObject({
        status: 'current',
        installedVersion: '1.0.0',
        latestVersion: '1.0.0',
      });
      expect(ctx.installer.update).not.toHaveBeenCalled();
    });

    it('passes the recorded commit, entry version and source key to the installer', async () => {
      // Purpose: the short-circuit can only compare what it is given.
      const sourceKey: SourceKey = {
        cloneUrl: 'https://example.com/marketplace',
        subpath: 'plugins/pkg',
        ref: 'main',
      };
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'pkg' }]),
        resolveLatest: async () => ({ kind: 'unchanged' }),
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'pkg', version: '1.0.0' }),
        installedFrom: 'fixture-marketplace',
        metadata: { commitSha: SHA_A, entryVersion: '1.0.0', sourceKey },
      });

      await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome);

      expect(ctx.installer.resolveLatest).toHaveBeenCalledWith(
        { name: 'pkg', marketplace: 'fixture-marketplace' },
        expect.objectContaining({
          installed: { commitSha: SHA_A, entryVersion: '1.0.0', sourceKey },
        })
      );
    });
  });

  describe('nothing is dropped', () => {
    it('reports an unreachable marketplace as unknown, never current', async () => {
      // Purpose: the old flow dropped the package and then said "All N up to date".
      const ctx = await setup({ marketplaceJson: buildMarketplaceJson([]) });
      ctx.fetcher.fetchMarketplaceJson.mockRejectedValue(new Error('ENOTFOUND'));
      const installPath = await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'pkg', version: '1.0.0' }),
      });

      const result = await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome);

      expect(result.checks).toEqual([
        {
          installPath,
          type: 'plugin',
          scope: 'global',
          packageName: 'pkg',
          installedVersion: '1.0.0',
          latestVersion: '',
          hasUpdate: false,
          marketplace: '',
          status: 'unknown',
          installedVersionSource: 'package',
          note: "couldn't read the marketplace list from fixture-marketplace",
        },
      ]);
    });

    it('reports a package no enabled marketplace lists as unknown', async () => {
      // Purpose: same rule, different reason — the note must say which.
      const ctx = await setup({ marketplaceJson: buildMarketplaceJson([{ name: 'other' }]) });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'pkg', version: '1.0.0' }),
      });

      const [check] = (await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome)).checks;

      expect(check).toMatchObject({
        status: 'unknown',
        note: 'no enabled marketplace lists this package',
      });
      expect(ctx.installer.resolveLatest).not.toHaveBeenCalled();
    });

    it("reports a new version DorkOS can't install as unknown, with the validator's message", async () => {
      // Purpose: a version that would be refused is never offered, and the
      // person is told why.
      const reason =
        "the new version can't be installed: .dork/manifest.json says version 1.0.0 but " +
        '.claude-plugin/plugin.json says 1.1.0.';
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'pkg' }]),
        resolveLatest: async () => ({ kind: 'unresolved', reason }),
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'pkg', version: '1.0.0' }),
      });

      const [check] = (await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome, { apply: true }))
        .checks;

      expect(check).toMatchObject({ status: 'unknown', latestVersion: '', note: reason });
      expect(ctx.installer.update).not.toHaveBeenCalled();
    });

    it('asks for a reinstall when the installed side names no version at all', async () => {
      // Purpose: a package with no declared version, no entry version and no
      // real commit cannot be compared; saying "current" would be a guess.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'bare' }]),
        latest: { bare: '1.0.0' },
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: null,
        pluginJson: { name: 'bare' },
        metadata: { commitSha: 'tmp-123' },
      });

      const [check] = (await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome)).checks;

      expect(check).toMatchObject({
        status: 'unknown',
        installedVersion: '',
        note: 'reinstall this package to enable update checks',
      });
    });

    it('returns one "not installed in this scope" result for a named package it cannot find', async () => {
      // Purpose: the route decides 404 vs this; the flow never throws for it.
      const ctx = await setup({ marketplaceJson: buildMarketplaceJson([{ name: 'anything' }]) });

      const result = await runNamed(new UpdateFlow(ctx.deps), ctx.dorkHome, {
        name: 'ghost-plugin',
      });

      expect(result.checks).toEqual([
        {
          packageName: 'ghost-plugin',
          installedVersion: '',
          latestVersion: '',
          hasUpdate: false,
          marketplace: '',
          status: 'unknown',
          note: 'not installed in this scope',
        },
      ]);
    });

    it('keeps hasUpdate equal to status === "update-available" on every result', async () => {
      // Purpose: old clients read hasUpdate; it must never disagree with status.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'up' }, { name: 'same' }]),
        latest: { up: '2.0.0', same: '1.0.0' },
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'up', version: '1.0.0' }),
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'same', version: '1.0.0' }),
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'unlisted', version: '1.0.0' }),
      });

      const { checks } = await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome);

      expect(checks.map((c) => c.status).sort()).toEqual([
        'current',
        'unknown',
        'update-available',
      ]);
      expectConsistent(checks);
    });
  });

  describe('which marketplace', () => {
    it('uses the installedFrom marketplace when it lists the package', async () => {
      // Purpose: provenance scopes the lookup, so only that index is fetched.
      const scopedSource = buildSource({ name: 'scoped-marketplace' });
      const otherSource = buildSource({ name: 'other-marketplace' });
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'scoped-plugin' }]),
        sources: [scopedSource, otherSource],
        latest: { 'scoped-plugin': '3.0.0' },
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'scoped-plugin', version: '1.0.0' }),
        installedFrom: 'scoped-marketplace',
      });

      const [check] = (
        await runNamed(new UpdateFlow(ctx.deps), ctx.dorkHome, { name: 'scoped-plugin' })
      ).checks;

      expect(check?.marketplace).toBe('scoped-marketplace');
      expect(ctx.fetcher.fetchMarketplaceJson).toHaveBeenCalledTimes(1);
      expect(ctx.fetcher.fetchMarketplaceJson).toHaveBeenCalledWith(scopedSource);
    });

    it('falls back to scanning every enabled source when installedFrom is absent', async () => {
      // Purpose: pre-provenance installs still find their marketplace.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'lost-plugin' }]),
        sources: [buildSource({ name: 'marketplace-a' }), buildSource({ name: 'marketplace-b' })],
        latest: { 'lost-plugin': '5.0.0' },
      });
      ctx.fetcher.fetchMarketplaceJson.mockImplementation(async (source: MarketplaceSource) =>
        source.name === 'marketplace-a'
          ? buildMarketplaceJson([])
          : buildMarketplaceJson([{ name: 'lost-plugin' }])
      );
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'lost-plugin', version: '4.0.0' }),
      });

      const [check] = (
        await runNamed(new UpdateFlow(ctx.deps), ctx.dorkHome, { name: 'lost-plugin' })
      ).checks;

      expect(check).toMatchObject({ marketplace: 'marketplace-b', status: 'update-available' });
      expect(ctx.fetcher.fetchMarketplaceJson).toHaveBeenCalledTimes(2);
    });

    it('passes the MATCHED source when two enabled sources list the same name', async () => {
      // Purpose: a bare name would throw AmbiguousPackageError in the resolver;
      // the flow must name the source it matched instead.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'dup' }]),
        sources: [buildSource({ name: 'marketplace-a' }), buildSource({ name: 'marketplace-b' })],
        latest: { dup: '2.0.0' },
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'dup', version: '1.0.0' }),
      });

      await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome);

      expect(ctx.installer.resolveLatest).toHaveBeenCalledWith(
        { name: 'dup', marketplace: 'marketplace-a' },
        expect.anything()
      );
    });

    it('checks a direct install against its recorded source, not a marketplace', async () => {
      // Purpose: a `name@url` install has no marketplace; its own source key
      // (with its ref) is what the check and the apply must use.
      const sourceKey: SourceKey = {
        cloneUrl: 'https://example.com/tool.git',
        subpath: '',
        ref: 'release',
      };
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([]),
        latest: { tool: '2.0.0' },
      });
      const installRoot = await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'tool', version: '1.0.0' }),
        metadata: { sourceRepo: sourceKey.cloneUrl, sourceKey, commitSha: SHA_A },
      });

      const result = await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome, { apply: true });

      expect(ctx.installer.resolveLatest).toHaveBeenCalledWith(
        { name: 'tool', source: sourceKey.cloneUrl },
        expect.objectContaining({ installed: expect.objectContaining({ sourceKey }) })
      );
      expect(result.checks[0]).toMatchObject({ status: 'update-available', marketplace: '' });
      expect(result.checks[0]?.note).toBeUndefined();
      expect(ctx.installer.update).toHaveBeenCalledWith({
        name: 'tool',
        source: sourceKey.cloneUrl,
        projectPath: undefined,
        installRoot,
        // Held to what its check disclosed: the only way a reinstall runs.
        approvedDisclosure: disclosedEffectsOf(buildEmptyPreview()),
      });
      expect(ctx.sourceManager.list).not.toHaveBeenCalled();
    });

    it('says a pre-sourceKey direct install was checked against its default branch', async () => {
      // Purpose: without a recorded ref the check cannot know the branch; it
      // must say so rather than silently compare against the default.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([]),
        latest: { tool: '1.0.0' },
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'tool', version: '1.0.0' }),
        metadata: { sourceRepo: 'https://example.com/tool.git' },
      });

      const [check] = (await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome)).checks;

      expect(ctx.installer.resolveLatest).toHaveBeenCalledWith(
        { name: 'tool', source: 'https://example.com/tool.git' },
        expect.anything()
      );
      expect(check?.status).toBe('current');
      expect(check?.note).toMatch(/default branch/);
    });
  });

  describe('apply', () => {
    it('reinstalls only update-available packages, from the matched marketplace', async () => {
      // Purpose: an apply never runs on unknown or current.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'up' }, { name: 'same' }]),
        latest: { up: '2.0.0', same: '1.0.0' },
      });
      const upRoot = await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'up', version: '1.0.0' }),
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'same', version: '1.0.0' }),
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'unlisted', version: '1.0.0' }),
      });

      const result = await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome, { apply: true });

      expect(ctx.installer.update).toHaveBeenCalledTimes(1);
      expect(ctx.installer.update).toHaveBeenCalledWith({
        name: 'up',
        marketplace: 'fixture-marketplace',
        projectPath: undefined,
        installRoot: upRoot,
        approvedDisclosure: disclosedEffectsOf(buildEmptyPreview()),
      });
      expect(result.applied.map((a) => a.packageName)).toEqual(['up']);
    });

    // The manifest is read off disk with no schema validation, and the name it
    // yields is handed to `installer.update()` — which uninstalls by name, and
    // joins that name into dorkHome. The directory entry name is the honest
    // fallback: it is a real directory that was actually walked, so it cannot
    // climb anywhere.
    it('falls back to the directory name when the manifest name is not a package name', async () => {
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'honest-plugin' }]),
        latest: { 'honest-plugin': '2.0.0' },
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        dirName: 'honest-plugin',
        manifest: {
          ...buildPluginManifest({ name: 'honest-plugin', version: '1.0.0' }),
          name: '../../../../etc/cron.d',
        },
      });

      const result = await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome, { apply: true });

      expect(result.checks[0]?.packageName).toBe('honest-plugin');
      expect(ctx.installer.update).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'honest-plugin' })
      );
    });

    it('never lists a crash-left install backup, even with a valid manifest (DOR-175)', async () => {
      // A crash mid-install leaves `<name>.dorkos-bak-<ts>-<uuid>` beside the
      // real installation — a byte-for-byte move-aside carrying a valid manifest
      // under the same package name. Without the exclusion, update-all would see
      // a phantom duplicate and could target the backup path with an apply.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'alpha' }]),
        latest: { alpha: '2.0.0' },
      });
      const realRoot = await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'alpha', version: '1.0.0' }),
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        dirName: `alpha.dorkos-bak-${Date.now()}-3fa85f64-5717-4562-b3fc-2c963f66afa6`,
        manifest: buildPluginManifest({ name: 'alpha', version: '0.9.0' }),
      });

      const result = await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome, { apply: true });

      expect(result.checks).toHaveLength(1);
      expect(result.checks[0]).toMatchObject({ packageName: 'alpha', installedVersion: '1.0.0' });
      expect(ctx.installer.update).toHaveBeenCalledTimes(1);
      expect(result.applied[0]?.installPath).toBe(realRoot);
    });
  });

  describe('planInstallations and applyPlan (the all-packages door)', () => {
    /** A temp directory standing in for a registered agent's project. */
    async function makeAgentDir(): Promise<string> {
      const dir = await mkdtemp(path.join(tmpdir(), 'update-flow-agent-'));
      cleanupDirs.push(dir);
      return dir;
    }

    /** One package installed globally and in one agent's project. */
    async function stageGlobalAndAgent(ctx: Awaited<ReturnType<typeof setup>>, name = 'flow') {
      const agentPath = await makeAgentDir();
      const globalRoot = await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name, version: '1.0.0' }),
      });
      const agentRoot = await stageProjectPlugin({
        projectPath: agentPath,
        manifest: buildPluginManifest({ name, version: '1.0.0' }),
      });
      const installations = await scanInstallationRecords(ctx.dorkHome, {
        agents: [{ projectPath: agentPath, id: 'agent-a', name: 'Alpha' }],
      });
      return { agentPath, globalRoot, agentRoot, installations };
    }

    it('checks every scope it is handed, one result per installation with its identity', async () => {
      // Purpose: the old name-less run never walked agent scopes, and reported
      // by name, so one package in two places read as one answer.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'flow' }]),
        latest: { flow: '2.0.0' },
      });
      const { agentPath, globalRoot, agentRoot, installations } = await stageGlobalAndAgent(ctx);

      const { checks } = await new UpdateFlow(ctx.deps).planInstallations({ installations });

      expect(checks).toHaveLength(2);
      expect(checks[0]).toMatchObject({
        packageName: 'flow',
        status: 'update-available',
        installPath: globalRoot,
        type: 'plugin',
        scope: 'global',
      });
      expect(checks[0]).not.toHaveProperty('agentPath');
      expect(checks[1]).toMatchObject({
        packageName: 'flow',
        status: 'update-available',
        installPath: agentRoot,
        scope: 'override',
        agentPath,
        agentId: 'agent-a',
        agentName: 'Alpha',
      });
      expectConsistent(checks);
    });

    it('never reinstalls anything without apply', async () => {
      // Purpose: the advisory door is a read; an update-available answer alone
      // must not touch an installed package.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'flow' }]),
        latest: { flow: '2.0.0' },
      });
      const { installations } = await stageGlobalAndAgent(ctx);

      const { checks } = await new UpdateFlow(ctx.deps).planInstallations({ installations });

      expect(checks.every((c) => c.status === 'update-available')).toBe(true);
      expect(ctx.installer.update).not.toHaveBeenCalled();
      expect(checks.some((c) => 'applied' in c || 'applyError' in c)).toBe(false);
    });

    it('reinstalls each installation in its own scope: global with no project, an agent in its own', async () => {
      // Purpose: an apply that carried one projectPath for the whole batch
      // would move the global install into that project, or the agent's into
      // the global scope.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'flow' }]),
        latest: { flow: '2.0.0' },
      });
      const { agentPath, installations } = await stageGlobalAndAgent(ctx);

      const { checks } = await applyAsShown(new UpdateFlow(ctx.deps), installations);

      expect(ctx.installer.update.mock.calls.map(([req]) => req.projectPath)).toEqual([
        undefined,
        agentPath,
      ]);
      expect(checks.map((c) => c.applied?.version)).toEqual(['2.0.0', '2.0.0']);
    });

    it('records a failed reinstall on its installation and carries on with the rest', async () => {
      // Purpose: a throw half-way through a batch used to hide what had
      // already landed; the next installation must still be reinstalled, and
      // the memo must still be cleared so the next check asks again.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'flow' }]),
        latest: { flow: '2.0.0' },
      });
      const { installations } = await stageGlobalAndAgent(ctx);
      ctx.installer.update.mockRejectedValueOnce(new Error('disk full'));
      const flow = new UpdateFlow(ctx.deps);

      const { checks } = await applyAsShown(flow, installations);

      expect(checks[0]).toMatchObject({ applyError: 'disk full' });
      expect(checks[0]).not.toHaveProperty('applied');
      expect(checks[1]?.applied?.version).toBe('2.0.0');
      expect(checks[1]).not.toHaveProperty('applyError');

      expect(ctx.fetcher.fetchMarketplaceJson).toHaveBeenCalledTimes(1);
      await flow.planInstallations({ installations });
      expect(ctx.fetcher.fetchMarketplaceJson).toHaveBeenCalledTimes(2);
    });

    it(`checks at most ${UPDATE_CHECK_CONCURRENCY} installations at once, and answers in scan order`, async () => {
      // Purpose: a whole-install check must not open one git process per
      // installation, and results must line up with the installations given.
      let inFlight = 0;
      let peak = 0;
      const names = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson(names.map((name) => ({ name }))),
        resolveLatest: async (req) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          return { kind: 'resolved', declaredVersion: `9.0.${names.indexOf(req.name)}` };
        },
      });
      for (const name of names) {
        await stageInstalledPlugin({
          dorkHome: ctx.dorkHome,
          manifest: buildPluginManifest({ name, version: '1.0.0' }),
        });
      }
      const installations = await scanInstallationRecords(ctx.dorkHome, { agents: [] });

      const { checks } = await new UpdateFlow(ctx.deps).planInstallations({ installations });

      expect(peak).toBe(UPDATE_CHECK_CONCURRENCY);
      expect(checks.map((c) => c.installPath)).toEqual(
        installations.map((r) => r.package.installPath)
      );
      expect(checks.map((c) => c.latestVersion)).toEqual(
        checks.map((c) => `9.0.${names.indexOf(c.packageName)}`)
      );
    });

    it('shares one in-flight lookup between installations of one repository, even a failing one', async () => {
      // Purpose: a failed lookup is never kept, so a sequential run paid the
      // ls-remote timeout once per installation; checked together they share it.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'flow' }]),
        resolveLatest: lookingUp(),
      });
      const { installations } = await stageGlobalAndAgent(ctx);
      ctx.fetcher.lookupCommitSha.mockImplementation(
        () =>
          new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timed out')), 5))
      );

      const { checks } = await new UpdateFlow(ctx.deps).planInstallations({ installations });

      expect(checks.map((c) => c.status)).toEqual(['unknown', 'unknown']);
      expect(ctx.fetcher.lookupCommitSha).toHaveBeenCalledTimes(1);
    });
  });

  describe('planning an approved apply (DOR-2195)', () => {
    /** Two stale packages installed globally. */
    async function stageTwo(ctx: Awaited<ReturnType<typeof setup>>) {
      const alpha = await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'alpha', version: '1.0.0' }),
      });
      const beta = await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'beta', version: '1.0.0' }),
      });
      const installations = await scanInstallationRecords(ctx.dorkHome, { agents: [] });
      return { alpha, beta, installations };
    }

    const HOOKED = buildEmptyPreview({ hooks: [{ event: 'Stop', command: 'echo new' }] });

    it('hashes the staged new version and says what the installed one runs now (DOR-2306)', async () => {
      // Purpose: an apply is refused when the staged files move, and a confirm
      // step shows what is new against what is installed.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'alpha' }]),
        latest: { alpha: '2.0.0' },
      });
      const staged = await mkdtemp(path.join(tmpdir(), 'update-flow-staged-'));
      cleanupDirs.push(staged);
      await writeFile(path.join(staged, 'fmt.sh'), 'echo new');
      ctx.installer.preview.mockResolvedValue({ preview: HOOKED, packagePath: staged });
      const alpha = await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'alpha', version: '1.0.0' }),
      });
      await mkdir(path.join(alpha, 'hooks'), { recursive: true });
      await writeFile(
        path.join(alpha, 'hooks', 'hooks.json'),
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo old' }] }] } })
      );

      const plan = await new UpdateFlow(ctx.deps).planInstallations({
        installations: await scanInstallationRecords(ctx.dorkHome, { agents: [] }),
        disclose: true,
      });

      expect(plan.checks[0]).toMatchObject({
        contentHash: await packageContentHash(staged),
        installedDisclosed: expect.objectContaining({
          hooks: [expect.objectContaining({ command: 'echo old' })],
        }),
      });
    });

    it('says what each new version would run, and previews nothing that is current', async () => {
      // Purpose: the card for an apply must show what the new version runs,
      // read from the version that would be installed, in its own scope.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'alpha' }, { name: 'beta' }]),
        latest: { alpha: '2.0.0', beta: '1.0.0' },
      });
      ctx.installer.preview.mockResolvedValue({ preview: HOOKED, packagePath: ctx.dorkHome });
      const { alpha, installations } = await stageTwo(ctx);

      const plan = await new UpdateFlow(ctx.deps).planInstallations({
        installations,
        disclose: true,
      });

      const byPath = new Map(plan.checks.map((c) => [c.installPath, c]));
      expect(byPath.get(alpha)).toMatchObject({
        status: 'update-available',
        disclosed: disclosedEffectsOf(HOOKED),
      });
      expect(plan.checks.find((c) => c.packageName === 'beta')).not.toHaveProperty('disclosed');
      expect(ctx.installer.preview).toHaveBeenCalledTimes(1);
      expect(ctx.installer.preview.mock.calls[0]![0]).toMatchObject({
        name: 'alpha',
        marketplace: 'fixture-marketplace',
        projectPath: undefined,
      });
    });

    it('never offers an update whose new version it could not read', async () => {
      // Purpose: an update nobody could be shown must not be approvable.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'alpha' }, { name: 'beta' }]),
        latest: { alpha: '2.0.0', beta: '1.0.0' },
      });
      ctx.installer.preview.mockRejectedValue(new Error('bad manifest'));
      const { alpha, installations } = await stageTwo(ctx);
      const flow = new UpdateFlow(ctx.deps);

      const plan = await flow.planInstallations({ installations, disclose: true });
      const check = plan.checks.find((c) => c.installPath === alpha)!;
      expect(check).toMatchObject({ status: 'unknown', hasUpdate: false });
      expect(check.note).toContain('bad manifest');

      await flow.applyPlan(plan, new Map([[alpha, null]]));
      expect(ctx.installer.update).not.toHaveBeenCalled();
    });

    it('never offers an update whose new version declares something it could not read', async () => {
      // Purpose: an unreadable declaration vanishes from a card that lists what
      // runs; approving it would approve something nobody could be shown.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'alpha' }, { name: 'beta' }]),
        latest: { alpha: '2.0.0', beta: '1.0.0' },
      });
      ctx.installer.preview.mockResolvedValue({
        preview: buildEmptyPreview({
          unreadableHooks: [{ path: 'hooks/hooks.json', event: 'Stop' }],
          unreadableDeclarations: [{ path: '.mcp.json', kind: 'mcp-server', entry: 'odd' }],
        }),
      });
      const { alpha, installations } = await stageTwo(ctx);

      const plan = await new UpdateFlow(ctx.deps).planInstallations({
        installations,
        disclose: true,
      });

      const check = plan.checks.find((c) => c.installPath === alpha)!;
      expect(check).toMatchObject({ status: 'unknown', hasUpdate: false });
      expect(check).not.toHaveProperty('disclosed');
      expect(check.note).toContain('hooks/hooks.json (Stop)');
      expect(check.note).toContain('.mcp.json (odd)');
    });

    it('reinstalls only the approved installations, each held to what was approved', async () => {
      // Purpose: the approval is per installation; the installer refuses one
      // whose new version declares something other than what the person saw.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'alpha' }, { name: 'beta' }]),
        latest: { alpha: '2.0.0', beta: '2.0.0' },
      });
      ctx.installer.preview.mockResolvedValue({ preview: HOOKED, packagePath: ctx.dorkHome });
      const { alpha, installations } = await stageTwo(ctx);
      const flow = new UpdateFlow(ctx.deps);

      const plan = await flow.planInstallations({ installations, disclose: true });
      const result = await flow.applyPlan(plan, new Map([[alpha, disclosedEffectsOf(HOOKED)]]));

      expect(ctx.installer.update).toHaveBeenCalledTimes(1);
      expect(ctx.installer.update.mock.calls[0]![0]).toMatchObject({
        name: 'alpha',
        installRoot: alpha,
        approvedDisclosure: disclosedEffectsOf(HOOKED),
      });
      expect(result.checks.filter((c) => c.applied).map((c) => c.installPath)).toEqual([alpha]);
    });
  });

  describe('a check that throws', () => {
    it("becomes that installation's unknown, and frees its slot for the checks queued behind it", async () => {
      // Purpose: one throwing check must neither fail the whole request nor
      // keep its slot — with every slot held by a failure, the rest would wait
      // forever.
      const names = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson(names.map((name) => ({ name }))),
        resolveLatest: async (req) => {
          if (['p1', 'p2', 'p3', 'p4'].includes(req.name)) throw new Error('boom');
          return { kind: 'resolved', declaredVersion: '9.0.0' };
        },
      });
      for (const name of names) {
        await stageInstalledPlugin({
          dorkHome: ctx.dorkHome,
          manifest: buildPluginManifest({ name, version: '1.0.0' }),
        });
      }

      const { checks } = await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome);

      const byName = Object.fromEntries(checks.map((c) => [c.packageName, c]));
      for (const name of ['p1', 'p2', 'p3', 'p4']) {
        expect(byName[name]).toMatchObject({
          status: 'unknown',
          hasUpdate: false,
          note: "couldn't check this package: boom",
        });
      }
      expect(byName.p5?.status).toBe('update-available');
      expect(byName.p6?.status).toBe('update-available');
    });

    it('answers unknown with the reason when the marketplace list itself cannot be read', async () => {
      // Purpose: an unreadable marketplaces file used to reject the whole
      // request as a 500; each installation now says why it went unchecked.
      const ctx = await setup({ marketplaceJson: buildMarketplaceJson([{ name: 'pkg' }]) });
      ctx.sourceManager.list.mockRejectedValue(new Error('marketplaces.json is not valid JSON'));
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'pkg', version: '1.0.0' }),
      });
      const flow = new UpdateFlow(ctx.deps);

      const all = await checkAll(flow, ctx.dorkHome);
      const one = await runNamed(flow, ctx.dorkHome, { name: 'pkg', apply: true });

      for (const check of [all.checks[0], one.checks[0]]) {
        expect(check).toMatchObject({
          status: 'unknown',
          installedVersion: '1.0.0',
          note: "couldn't check this package: marketplaces.json is not valid JSON",
        });
      }
      expect(ctx.installer.update).not.toHaveBeenCalled();
    });
  });

  describe('the exact installation an apply replaces', () => {
    it('hands the installer the install root the check resolved, when one name lives in two roots', async () => {
      // Purpose: the installer finds a target by name, first root wins — so a
      // plugin and an agent both called "twin" could have the wrong one
      // replaced. The apply names the exact root.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'twin' }]),
        latest: { twin: '9.0.0' },
      });
      const pluginRoot = await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'twin', version: '1.0.0' }),
      });
      const agentRoot = await stageInstalledAgent({
        scopeRoot: ctx.dorkHome,
        name: 'twin',
        version: '1.0.0',
      });
      const flow = new UpdateFlow(ctx.deps);

      await checkAll(flow, ctx.dorkHome, { apply: true });
      await runNamed(flow, ctx.dorkHome, { name: 'twin', apply: true });

      expect(ctx.installer.update.mock.calls.map(([req]) => req.installRoot).sort()).toEqual(
        [pluginRoot, agentRoot, pluginRoot].sort()
      );
    });
  });

  describe('linked installs', () => {
    it('checks a symlinked install as unknown, and never reinstalls it', async () => {
      // Purpose: a linked working copy would be replaced by a fresh fetch if
      // it were reinstalled; the check says what to do instead.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'dev' }]),
        latest: { dev: '9.0.0' },
      });
      const source = await mkdtemp(path.join(tmpdir(), 'update-flow-working-copy-'));
      cleanupDirs.push(source);
      await stagePluginUnder(source, {
        manifest: buildPluginManifest({ name: 'dev', version: '1.0.0' }),
      });
      await mkdir(path.join(ctx.dorkHome, 'plugins'), { recursive: true });
      await symlink(path.join(source, 'dev'), path.join(ctx.dorkHome, 'plugins', 'dev'));
      const flow = new UpdateFlow(ctx.deps);

      const { checks } = await checkAll(flow, ctx.dorkHome, { apply: true });
      const named = await runNamed(flow, ctx.dorkHome, { name: 'dev', apply: true });

      for (const check of [checks[0], named.checks[0]]) {
        expect(check).toMatchObject({
          status: 'unknown',
          installedVersion: '1.0.0',
          note: 'linked install — update its source instead',
        });
      }
      expect(ctx.installer.resolveLatest).not.toHaveBeenCalled();
      expect(ctx.installer.update).not.toHaveBeenCalled();
    });
  });

  describe('the server-wide check cap', () => {
    it(`holds ${UPDATE_CHECK_CONCURRENCY} checks at most across concurrent requests`, async () => {
      // Purpose: the cap lives on the one flow instance, so two whole-install
      // checks arriving together cannot open twice the git processes.
      let inFlight = 0;
      let peak = 0;
      const names = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson(names.map((name) => ({ name }))),
        resolveLatest: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          return { kind: 'resolved', declaredVersion: '9.0.0' };
        },
      });
      for (const name of names) {
        await stageInstalledPlugin({
          dorkHome: ctx.dorkHome,
          manifest: buildPluginManifest({ name, version: '1.0.0' }),
        });
      }
      const flow = new UpdateFlow(ctx.deps);

      await Promise.all([
        checkAll(flow, ctx.dorkHome),
        checkAll(flow, ctx.dorkHome),
        runNamed(flow, ctx.dorkHome, { name: 'p1' }),
      ]);

      expect(ctx.installer.resolveLatest).toHaveBeenCalledTimes(13);
      expect(peak).toBe(UPDATE_CHECK_CONCURRENCY);
    });
  });

  describe('selectInstallations', () => {
    /** Two global packages and one agent install of the first. */
    async function stageThree(): Promise<Awaited<ReturnType<typeof scanInstallationRecords>>> {
      const ctx = await setup({ marketplaceJson: buildMarketplaceJson([]) });
      const agentPath = await mkdtemp(path.join(tmpdir(), 'update-flow-agent-'));
      cleanupDirs.push(agentPath);
      for (const name of ['alpha', 'beta']) {
        await stageInstalledPlugin({
          dorkHome: ctx.dorkHome,
          manifest: buildPluginManifest({ name, version: '1.0.0' }),
        });
      }
      await stageProjectPlugin({
        projectPath: agentPath,
        manifest: buildPluginManifest({ name: 'alpha', version: '1.0.0' }),
      });
      return scanInstallationRecords(ctx.dorkHome, { agents: [{ projectPath: agentPath }] });
    }

    it('keeps every installation when no names, or an empty list, are given', async () => {
      // Purpose: "update everything" is the default, and an empty list must
      // not silently mean "nothing".
      const records = await stageThree();
      expect(selectInstallations(records)).toHaveLength(3);
      expect(selectInstallations(records, { names: [], installPaths: [] })).toHaveLength(3);
    });

    it('keeps every installation of a named package, in every scope', async () => {
      // Purpose: a name is a package, and the same package in two places is
      // two installations to update.
      const records = await stageThree();
      const selected = selectInstallations(records, { names: ['alpha'] });
      expect(selected.map((r) => [r.package.name, r.package.scope])).toEqual([
        ['alpha', 'global'],
        ['alpha', 'override'],
      ]);
    });

    it('refuses before anything runs, naming every name that matched nothing', async () => {
      // Purpose: a typo in a batch must fail loudly and whole, not update the
      // rest and quietly skip the one the caller meant.
      const records = await stageThree();
      let caught: unknown;
      try {
        selectInstallations(records, {
          names: ['alpha', 'flwo', 'gone'],
          installPaths: [records[0]!.package.installPath, '/nowhere/flow'],
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PackageNotInstalledForUpdateError);
      expect((caught as PackageNotInstalledForUpdateError).packageNames).toEqual(['flwo', 'gone']);
      expect((caught as PackageNotInstalledForUpdateError).installPaths).toEqual(['/nowhere/flow']);
      expect((caught as Error).message).toBe(
        'Packages not installed: flwo, gone. No installation at: /nowhere/flow'
      );
    });

    it('keeps exactly the installations a confirm step showed, by install path', async () => {
      // Purpose: "Update all" must apply what it listed and nothing else — not
      // every installation that happens to share a name.
      const records = await stageThree();
      const agentAlpha = records.find((r) => r.package.scope === 'override')!;

      const selected = selectInstallations(records, {
        installPaths: [agentAlpha.package.installPath],
      });

      expect(selected).toEqual([agentAlpha]);
      expect(
        selectInstallations(records, {
          names: ['alpha'],
          installPaths: [agentAlpha.package.installPath],
        })
      ).toEqual([agentAlpha]);
    });
  });

  describe('memoized commit lookups', () => {
    /** One installed package whose check consults the commit lookup. */
    async function stageOne(ctx: Awaited<ReturnType<typeof setup>>, name = 'pkg') {
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name, version: '1.0.0' }),
      });
    }

    it('shares a lookup across run() calls within the TTL, and repeats it after', async () => {
      // Purpose: the CLI sends one request per package, so the memo must live
      // on the instance — and must expire, or a push would never be seen.
      let now = 1_000;
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'pkg' }]),
        resolveLatest: lookingUp(),
        now: () => now,
      });
      await stageOne(ctx);
      const flow = new UpdateFlow(ctx.deps);

      await checkAll(flow, ctx.dorkHome);
      await checkAll(flow, ctx.dorkHome);
      expect(ctx.fetcher.lookupCommitSha).toHaveBeenCalledTimes(1);

      now += UPDATE_MEMO_TTL_MS + 1;
      await checkAll(flow, ctx.dorkHome);
      expect(ctx.fetcher.lookupCommitSha).toHaveBeenCalledTimes(2);
    });

    it('shares one in-flight lookup between concurrent runs', async () => {
      // Purpose: the CLI and the app checking together cost one ls-remote.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'pkg' }]),
        resolveLatest: lookingUp(),
      });
      await stageOne(ctx);
      let release: (sha: string) => void = () => {};
      ctx.fetcher.lookupCommitSha.mockImplementation(
        () => new Promise<string>((resolve) => (release = resolve))
      );
      const flow = new UpdateFlow(ctx.deps);

      const both = Promise.all([checkAll(flow, ctx.dorkHome), checkAll(flow, ctx.dorkHome)]);
      await vi.waitFor(() => expect(ctx.fetcher.lookupCommitSha).toHaveBeenCalled());
      release(SHA_A);
      await both;

      expect(ctx.fetcher.lookupCommitSha).toHaveBeenCalledTimes(1);
    });

    it('never keeps a failed lookup or a placeholder', async () => {
      // Purpose: a retry after the network returns must look again, not
      // replay the failure for a minute.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'pkg' }]),
        resolveLatest: lookingUp(),
      });
      await stageOne(ctx);
      ctx.fetcher.lookupCommitSha
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce('tmp-1')
        .mockResolvedValue(SHA_A);
      const flow = new UpdateFlow(ctx.deps);

      await checkAll(flow, ctx.dorkHome);
      await checkAll(flow, ctx.dorkHome);
      await checkAll(flow, ctx.dorkHome);
      await checkAll(flow, ctx.dorkHome);

      expect(ctx.fetcher.lookupCommitSha).toHaveBeenCalledTimes(3);
    });

    it('is cleared by clearMemos() and by an apply', async () => {
      // Purpose: "I just pushed; check again" after a refresh, and a check
      // right after an install, must both ask again.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'pkg' }]),
        resolveLatest: lookingUp('main', { kind: 'resolved', declaredVersion: '2.0.0' }),
      });
      await stageOne(ctx);
      const flow = new UpdateFlow(ctx.deps);

      await checkAll(flow, ctx.dorkHome);
      flow.clearMemos();
      await checkAll(flow, ctx.dorkHome);
      expect(ctx.fetcher.lookupCommitSha).toHaveBeenCalledTimes(2);

      // The apply run's own check is served from the memo; the apply then
      // clears it, so only the run after it looks again.
      await checkAll(flow, ctx.dorkHome, { apply: true });
      expect(ctx.installer.update).toHaveBeenCalledTimes(1);
      expect(ctx.fetcher.lookupCommitSha).toHaveBeenCalledTimes(2);
      await checkAll(flow, ctx.dorkHome);
      expect(ctx.fetcher.lookupCommitSha).toHaveBeenCalledTimes(3);
    });

    it('treats a full-SHA ref as its own commit, with no ls-remote', async () => {
      // Purpose: ls-remote matches ref names only, so asking it about a pinned
      // SHA would report the package unreachable.
      let seen: string | undefined;
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'pkg' }]),
        resolveLatest: async (_req, opts) => {
          seen = await opts.commitLookup('https://example.com/marketplace', SHA_B);
          return { kind: 'unchanged' };
        },
      });
      await stageOne(ctx);

      await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome);

      expect(seen).toBe(SHA_B);
      expect(ctx.fetcher.lookupCommitSha).not.toHaveBeenCalled();
    });
  });

  describe('scopes', () => {
    /** Make a temp directory standing in for a caller's `projectPath`. */
    async function makeProjectDir(): Promise<string> {
      const dir = await mkdtemp(path.join(tmpdir(), 'update-flow-project-'));
      cleanupDirs.push(dir);
      return dir;
    }

    it('checks every installed package when no name is supplied', async () => {
      // Purpose: the name-less run covers the whole scope.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'alpha' }, { name: 'beta' }]),
        latest: { alpha: '1.1.0', beta: '2.0.0' },
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'alpha', version: '1.0.0' }),
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'beta', version: '2.0.0' }),
      });

      const { checks } = await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome);

      expect(checks.find((c) => c.packageName === 'alpha')?.status).toBe('update-available');
      expect(checks.find((c) => c.packageName === 'beta')?.status).toBe('current');
    });

    it('finds a package installed only in the project when projectPath is supplied', async () => {
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'local-plugin' }]),
        latest: { 'local-plugin': '2.0.0' },
      });
      const projectPath = await makeProjectDir();
      await stageProjectPlugin({
        projectPath,
        manifest: buildPluginManifest({ name: 'local-plugin', version: '1.0.0' }),
      });

      const result = await runNamed(new UpdateFlow(ctx.deps), ctx.dorkHome, {
        name: 'local-plugin',
        projectPath,
      });

      expect(result.checks[0]).toMatchObject({
        packageName: 'local-plugin',
        installedVersion: '1.0.0',
        latestVersion: '2.0.0',
        status: 'update-available',
      });
    });

    it('answers "not installed in this scope" when the package is in neither scope', async () => {
      // Purpose: replaces the old throw; the route owns the 404.
      const ctx = await setup({ marketplaceJson: buildMarketplaceJson([{ name: 'anything' }]) });
      const projectPath = await makeProjectDir();

      const result = await runNamed(new UpdateFlow(ctx.deps), ctx.dorkHome, {
        name: 'ghost-plugin',
        projectPath,
      });

      expect(result.checks).toHaveLength(1);
      expect(result.checks[0]).toMatchObject({
        status: 'unknown',
        note: 'not installed in this scope',
      });
    });

    it('finds a global-only package when projectPath is supplied — the project scan adds, never replaces', async () => {
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'global-plugin' }]),
        latest: { 'global-plugin': '3.0.0' },
      });
      const projectPath = await makeProjectDir();
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'global-plugin', version: '1.0.0' }),
      });

      const result = await runNamed(new UpdateFlow(ctx.deps), ctx.dorkHome, {
        name: 'global-plugin',
        projectPath,
      });

      expect(result.checks[0]?.installedVersion).toBe('1.0.0');
    });

    it('resolves a name installed in both scopes to the project copy when projectPath is supplied', async () => {
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'both-plugin' }]),
        latest: { 'both-plugin': '9.0.0' },
      });
      const projectPath = await makeProjectDir();
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'both-plugin', version: '1.0.0' }),
      });
      await stageProjectPlugin({
        projectPath,
        manifest: buildPluginManifest({ name: 'both-plugin', version: '2.0.0' }),
      });

      const result = await runNamed(new UpdateFlow(ctx.deps), ctx.dorkHome, {
        name: 'both-plugin',
        projectPath,
      });

      // The project copy (2.0.0) shadows the global one (1.0.0) for this project.
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0]?.installedVersion).toBe('2.0.0');
    });

    it('resolves the same name to the global copy when no projectPath is supplied', async () => {
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'both-plugin' }]),
        latest: { 'both-plugin': '9.0.0' },
      });
      const projectPath = await makeProjectDir();
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'both-plugin', version: '1.0.0' }),
      });
      await stageProjectPlugin({
        projectPath,
        manifest: buildPluginManifest({ name: 'both-plugin', version: '2.0.0' }),
      });

      const result = await runNamed(new UpdateFlow(ctx.deps), ctx.dorkHome, {
        name: 'both-plugin',
      });

      expect(result.checks[0]?.installedVersion).toBe('1.0.0');
    });

    it('checks a name installed in both scopes once, so an applied update reinstalls once', async () => {
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'both-plugin' }]),
        latest: { 'both-plugin': '9.0.0' },
      });
      const projectPath = await makeProjectDir();
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'both-plugin', version: '1.0.0' }),
      });
      await stageProjectPlugin({
        projectPath,
        manifest: buildPluginManifest({ name: 'both-plugin', version: '2.0.0' }),
      });

      const result = await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome, {
        apply: true,
        projectPath,
      });

      expect(result.checks).toHaveLength(1);
      expect(ctx.installer.update).toHaveBeenCalledTimes(1);
      expect(ctx.installer.update).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'both-plugin', projectPath })
      );
    });

    it('reinstalls a global-only package globally even when the request named a project', async () => {
      // Purpose: the apply used to hand the request's projectPath to the
      // installer, which removed the GLOBAL install and reinstalled it into the
      // project — moving a package every other project relied on.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'global-plugin' }]),
        latest: { 'global-plugin': '3.0.0' },
      });
      const projectPath = await makeProjectDir();
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'global-plugin', version: '1.0.0' }),
      });

      await runNamed(new UpdateFlow(ctx.deps), ctx.dorkHome, {
        name: 'global-plugin',
        apply: true,
        projectPath,
      });

      expect(ctx.installer.update).toHaveBeenCalledTimes(1);
      expect(ctx.installer.update.mock.calls[0]?.[0]?.projectPath).toBeUndefined();
    });

    it('reports both roots when one name is installed as a plugin AND an agent globally', async () => {
      // `ConflictDetector` lets a same-name package of a different type coexist
      // in the other root (a non-blocking warning, not an error), so these are
      // two genuinely different packages. Deduping on the name alone would drop
      // one of them from update-all — and each resolves its own marketplace.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'twin' }]),
        latest: { twin: '9.0.0' },
      });
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'twin', version: '1.0.0' }),
      });
      await stageInstalledAgent({ scopeRoot: ctx.dorkHome, name: 'twin', version: '1.5.0' });

      const result = await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome);

      expect(result.checks.map((c) => c.installedVersion).sort()).toEqual(['1.0.0', '1.5.0']);
      expect(result.checks.every((c) => c.packageName === 'twin')).toBe(true);
    });

    it('shadows only the matching root: project plugin wins, global agent survives', async () => {
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'twin' }]),
        latest: { twin: '9.0.0' },
      });
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

      const result = await checkAll(new UpdateFlow(ctx.deps), ctx.dorkHome, { projectPath });

      // The project's plugins/twin shadows the global plugins/twin (1.0.0 is
      // gone), while the global agents/twin is a different root and survives.
      expect(result.checks.map((c) => c.installedVersion).sort()).toEqual(['1.5.0', '2.0.0']);
    });

    it("resolves a name to the project's installation when the global one sits in another root", async () => {
      // Purpose: the project scope shadows the global one for that project even
      // across roots — a project agent named "twin" is what that project means,
      // not the global plugin of the same name.
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'twin' }]),
        latest: { twin: '9.0.0' },
      });
      const projectPath = await makeProjectDir();
      await stageInstalledPlugin({
        dorkHome: ctx.dorkHome,
        manifest: buildPluginManifest({ name: 'twin', version: '1.0.0' }),
      });
      await stageInstalledAgent({
        scopeRoot: path.join(projectPath, '.dork'),
        name: 'twin',
        version: '1.5.0',
      });

      const result = await runNamed(new UpdateFlow(ctx.deps), ctx.dorkHome, {
        name: 'twin',
        projectPath,
      });

      expect(result.checks[0]?.installedVersion).toBe('1.5.0');
    });

    it('skips an unreadable project manifest, mirroring the global walk', async () => {
      const ctx = await setup({
        marketplaceJson: buildMarketplaceJson([{ name: 'broken-plugin' }]),
        latest: { 'broken-plugin': '2.0.0' },
      });
      const projectPath = await makeProjectDir();
      const brokenRoot = path.join(projectPath, '.dork', 'plugins', 'broken-plugin', '.dork');
      await mkdir(brokenRoot, { recursive: true });
      await writeFile(path.join(brokenRoot, 'manifest.json'), '{ not json', 'utf-8');
      const flow = new UpdateFlow(ctx.deps);

      expect((await checkAll(flow, ctx.dorkHome, { projectPath })).checks).toHaveLength(0);
      expect(
        (await runNamed(flow, ctx.dorkHome, { name: 'broken-plugin', projectPath })).checks[0]
      ).toMatchObject({
        status: 'unknown',
        note: 'not installed in this scope',
      });
    });
  });
});
