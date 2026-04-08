/**
 * End-to-end integration tests for the marketplace install pipeline.
 *
 * Unlike the per-flow tests under `./flows/`, these exercise the
 * {@link MarketplaceInstaller} orchestrator with every real collaborator
 * wired in — resolver, cache, fetcher, validator, permission preview
 * builder, conflict detector, and all four type-specific install flows.
 * The only things stubbed are the external side-effect surfaces:
 *
 * - `templateDownloader.cloneRepository` — never called in practice
 *   because the fixtures resolve via `kind: 'local'`, but provided as a
 *   throwing stub so any accidental network attempt fails loudly.
 * - `extensionCompiler.compile` / `extensionManager.enable` — spy `vi.fn()`s.
 * - `agentCreator.createAgentWorkspace` — spy `vi.fn()` that mirrors the
 *   shape the real agent-creator returns. Stubbed because the real impl
 *   pulls in `configManager`, boundary validation, and mesh sync that
 *   are not appropriate for an install-pipeline integration test.
 * - `adapterManager.addAdapter` / `removeAdapter` / `listAdapters` — spy
 *   `vi.fn()`s. Stubbed to avoid loading the entire relay subsystem.
 *
 * CRITICAL safety notes:
 *
 * 1. Every test runs against a temp `dorkHome` created under
 *    `os.tmpdir()` so no install writes to the live worktree.
 * 2. `beforeEach` also mocks
 *    {@link transactionInternal.isGitRepo} → `false` so the transaction
 *    engine's `git reset --hard <backup-branch>` rollback path cannot
 *    run against the live worktree on a failure. Both defenses combined
 *    — temp dir AND mock — because the price of getting this wrong is
 *    destroying uncommitted work in the calling worktree.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { noopLogger } from '@dorkos/shared/logger';
import type { Logger } from '@dorkos/shared/logger';
import type { AdapterManager } from '../../relay/adapter-manager.js';
import { ConflictDetector } from '../conflict-detector.js';
import { MarketplaceCache } from '../marketplace-cache.js';
import { MarketplaceInstaller } from '../marketplace-installer.js';
import { MarketplaceSourceManager } from '../marketplace-source-manager.js';
import { PackageFetcher } from '../package-fetcher.js';
import { PackageResolver } from '../package-resolver.js';
import { PermissionPreviewBuilder } from '../permission-preview.js';
import type { TemplateDownloader } from '../../core/template-downloader.js';
import { AdapterInstallFlow } from '../flows/install-adapter.js';
import { AgentInstallFlow } from '../flows/install-agent.js';
import { PluginInstallFlow } from '../flows/install-plugin.js';
import { SkillPackInstallFlow } from '../flows/install-skill-pack.js';
import { UninstallFlow } from '../flows/uninstall.js';
import { _internal as transactionInternal } from '../transaction.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the valid fixtures shipped alongside this test file. */
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

/** Resolve the absolute path of a valid fixture directory. */
function fixturePath(name: 'valid-plugin' | 'valid-agent' | 'valid-skill-pack' | 'valid-adapter') {
  return path.join(FIXTURES_DIR, name);
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
 * Spies exposed by {@link buildInstallerForTests} so individual test
 * cases can assert that the correct side-effects fired.
 */
export interface InstallerTestSpies {
  extensionCompile: ReturnType<typeof vi.fn>;
  extensionEnable: ReturnType<typeof vi.fn>;
  createAgentWorkspace: ReturnType<typeof vi.fn>;
  adapterAdd: ReturnType<typeof vi.fn>;
  adapterRemove: ReturnType<typeof vi.fn>;
  templateClone: ReturnType<typeof vi.fn>;
}

/** Result of {@link buildInstallerForTests}. */
export interface InstallerTestHarness {
  installer: MarketplaceInstaller;
  dorkHome: string;
  spies: InstallerTestSpies;
  logger: Logger;
}

/**
 * Wire a full {@link MarketplaceInstaller} with real collaborators
 * rooted at the supplied temp `dorkHome`. Only the four external
 * side-effect surfaces are stubbed (see file-level doc). Exported so
 * sibling failure-path tests (task #26) can reuse the same wiring.
 */
export function buildInstallerForTests(dorkHome: string): InstallerTestHarness {
  const logger = noopLogger;

  // Marketplace cache + source manager — both just need a dorkHome. They
  // are exercised lightly here because the fixtures resolve as `local`,
  // bypassing marketplace lookup. Wired in anyway so the full graph runs.
  const sourceManager = new MarketplaceSourceManager(dorkHome);
  const cache = new MarketplaceCache(dorkHome);

  // Template downloader stub — throws loudly if any code path attempts a
  // real clone. Local-path fixtures must never reach the fetcher.
  const templateClone = vi.fn(async () => {
    throw new Error('templateDownloader.cloneRepository must not be called for local fixtures');
  });
  const templateDownloader = {
    cloneRepository: templateClone,
  } as unknown as TemplateDownloader;

  const fetcher = new PackageFetcher(cache, templateDownloader, logger);
  const resolver = new PackageResolver(sourceManager, cache);

  // Adapter manager stub — just enough surface for ConflictDetector
  // (`listAdapters`) and the adapter install flow (`addAdapter`,
  // `removeAdapter`). The real AdapterManager pulls in the whole relay
  // subsystem which is out of scope for the install pipeline.
  const adapterAdd = vi.fn().mockResolvedValue(undefined);
  const adapterRemove = vi.fn().mockResolvedValue(undefined);
  const adapterList = vi.fn().mockReturnValue([]);
  const adapterManager = {
    addAdapter: adapterAdd,
    removeAdapter: adapterRemove,
    listAdapters: adapterList,
  } as unknown as AdapterManager;

  const conflictDetector = new ConflictDetector(dorkHome, adapterManager);
  const previewBuilder = new PermissionPreviewBuilder(dorkHome, conflictDetector);

  // Extension compiler / manager stubs — structural interfaces mirrored
  // by `ExtensionCompilerLike` / `ExtensionManagerLike` in install-plugin.ts.
  const extensionCompile = vi
    .fn()
    .mockResolvedValue({ code: 'compiled', sourceHash: 'integration-test' });
  const extensionEnable = vi.fn().mockResolvedValue({ extension: {}, reloadRequired: false });
  const extensionCompiler = { compile: extensionCompile };
  const extensionManager = {
    enable: extensionEnable,
    disable: vi.fn().mockResolvedValue(undefined),
  };

  // Agent creator stub — the real implementation pulls in configManager,
  // boundary validation, ulid, and mesh sync. The marketplace install
  // pipeline passes `skipTemplateDownload: true`, but the scaffold
  // pipeline itself is not what we're integration-testing here. We only
  // care that the flow calls the creator with the expected shape.
  const createAgentWorkspace = vi.fn(async (input: { directory: string; name: string }) => {
    return {
      manifest: { id: 'integration-test-id', name: input.name },
      path: input.directory,
    };
  });
  const agentCreator = { createAgentWorkspace };

  // Type-specific install flows — real implementations, stub collaborators.
  const pluginFlow = new PluginInstallFlow({
    dorkHome,
    extensionCompiler,
    extensionManager,
    logger,
  });
  const agentFlow = new AgentInstallFlow({
    dorkHome,
    agentCreator,
    logger,
  });
  const skillPackFlow = new SkillPackInstallFlow({ dorkHome, logger });
  const adapterFlow = new AdapterInstallFlow({ dorkHome, adapterManager, logger });
  const uninstallFlow = new UninstallFlow({
    dorkHome,
    extensionManager,
    adapterManager,
    logger,
  });

  const installer = new MarketplaceInstaller({
    dorkHome,
    resolver,
    fetcher,
    previewBuilder,
    pluginFlow,
    agentFlow,
    skillPackFlow,
    adapterFlow,
    uninstallFlow,
    logger,
  });

  return {
    installer,
    dorkHome,
    logger,
    spies: {
      extensionCompile,
      extensionEnable,
      createAgentWorkspace,
      adapterAdd,
      adapterRemove,
      templateClone,
    },
  };
}

describe('marketplace install pipeline — integration', () => {
  let dorkHome: string;

  beforeEach(async () => {
    // CRITICAL: neutralise the transaction engine's `git reset --hard`
    // rollback path. Combined with the temp dorkHome below, this
    // prevents any test failure from writing to the live worktree.
    vi.spyOn(transactionInternal, 'isGitRepo').mockResolvedValue(false);

    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-marketplace-integration-'));
    // Pre-seed an empty `plugins/` so the rename activation in
    // install-plugin / install-skill-pack / install-adapter has a
    // parent that already exists on the first run.
    await mkdir(path.join(dorkHome, 'plugins'), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dorkHome, { recursive: true, force: true }).catch(() => undefined);
  });

  it('installs a plugin package end-to-end via MarketplaceInstaller', async () => {
    const { installer, spies } = buildInstallerForTests(dorkHome);

    const result = await installer.install({ name: fixturePath('valid-plugin') });

    const expectedInstallRoot = path.join(dorkHome, 'plugins', 'valid-plugin');
    expect(result.ok).toBe(true);
    expect(result.type).toBe('plugin');
    expect(result.packageName).toBe('valid-plugin');
    expect(result.version).toBe('1.0.0');
    expect(result.installPath).toBe(expectedInstallRoot);

    // Disk state: manifest and the sample extension dir made the trip.
    expect(await pathExists(path.join(expectedInstallRoot, '.dork', 'manifest.json'))).toBe(true);
    expect(
      await pathExists(path.join(expectedInstallRoot, '.dork', 'extensions', 'sample-ext'))
    ).toBe(true);
    expect(
      await pathExists(
        path.join(expectedInstallRoot, '.dork', 'extensions', 'sample-ext', 'extension.json')
      )
    ).toBe(true);

    // The fixture ships a structurally valid `extension.json` (id +
    // name + version + entry), so `discoverStagedExtensions` finds it
    // and the plugin flow runs the full compile + enable activation.
    // The compiler/manager spies stand in for the real subsystems —
    // the integration test just verifies the install pipeline reaches
    // them, not that they actually emit valid bundles.
    expect(spies.extensionCompile).toHaveBeenCalledTimes(1);
    expect(spies.extensionEnable).toHaveBeenCalledWith('sample-ext');

    // The template downloader must not have been invoked: local paths
    // resolve via `kind: 'local'` and skip the fetcher entirely.
    expect(spies.templateClone).not.toHaveBeenCalled();
  });

  it('installs an agent package end-to-end via MarketplaceInstaller', async () => {
    const { installer, spies } = buildInstallerForTests(dorkHome);

    const result = await installer.install({ name: fixturePath('valid-agent') });

    const expectedInstallRoot = path.join(dorkHome, 'agents', 'valid-agent');
    expect(result.ok).toBe(true);
    expect(result.type).toBe('agent');
    expect(result.packageName).toBe('valid-agent');
    expect(result.version).toBe('1.0.0');
    expect(result.installPath).toBe(expectedInstallRoot);

    // Disk state: the agent package contents moved onto the install root.
    expect(await pathExists(path.join(expectedInstallRoot, '.dork', 'manifest.json'))).toBe(true);
    // And its contents match the fixture (sanity check against drift).
    const installedManifestRaw = await readFile(
      path.join(expectedInstallRoot, '.dork', 'manifest.json'),
      'utf-8'
    );
    expect(JSON.parse(installedManifestRaw)).toMatchObject({
      name: 'valid-agent',
      type: 'agent',
    });

    // The flow must delegate to `createAgentWorkspace` with the
    // marketplace-specific `skipTemplateDownload: true` flag. The
    // traits from `agentDefaults.traits` must be forwarded verbatim.
    expect(spies.createAgentWorkspace).toHaveBeenCalledTimes(1);
    const callArgs = spies.createAgentWorkspace.mock.calls[0]?.[0] as {
      directory: string;
      name: string;
      skipTemplateDownload: boolean;
      traits: Record<string, number>;
    };
    expect(callArgs.directory).toBe(expectedInstallRoot);
    expect(callArgs.name).toBe('valid-agent');
    expect(callArgs.skipTemplateDownload).toBe(true);
    expect(callArgs.traits).toEqual({
      tone: 3,
      autonomy: 4,
      caution: 3,
      communication: 3,
      creativity: 3,
    });

    expect(spies.templateClone).not.toHaveBeenCalled();
  });

  it('installs a skill-pack package end-to-end via MarketplaceInstaller', async () => {
    const { installer, spies } = buildInstallerForTests(dorkHome);

    const result = await installer.install({ name: fixturePath('valid-skill-pack') });

    const expectedInstallRoot = path.join(dorkHome, 'plugins', 'valid-skill-pack');
    expect(result.ok).toBe(true);
    expect(result.type).toBe('skill-pack');
    expect(result.packageName).toBe('valid-skill-pack');
    expect(result.version).toBe('1.0.0');
    expect(result.installPath).toBe(expectedInstallRoot);

    // Disk state: all three SKILL.md files from the fixture are present.
    for (const skill of ['analyzer', 'summarizer', 'translator']) {
      expect(await pathExists(path.join(expectedInstallRoot, 'skills', skill, 'SKILL.md'))).toBe(
        true
      );
    }
    expect(await pathExists(path.join(expectedInstallRoot, '.dork', 'manifest.json'))).toBe(true);

    // No flows touched the adapter manager or agent creator.
    expect(spies.adapterAdd).not.toHaveBeenCalled();
    expect(spies.createAgentWorkspace).not.toHaveBeenCalled();
    expect(spies.templateClone).not.toHaveBeenCalled();
  });

  it('installs an adapter package end-to-end via MarketplaceInstaller', async () => {
    const { installer, spies } = buildInstallerForTests(dorkHome);

    const result = await installer.install({ name: fixturePath('valid-adapter') });

    const expectedInstallRoot = path.join(dorkHome, 'plugins', 'valid-adapter');
    expect(result.ok).toBe(true);
    expect(result.type).toBe('adapter');
    expect(result.packageName).toBe('valid-adapter');
    expect(result.version).toBe('1.0.0');
    expect(result.installPath).toBe(expectedInstallRoot);
    expect(result.warnings).toContain(
      'Configure secrets via dorkos relay-adapters set valid-adapter'
    );

    // Disk state: the adapter package contents moved onto the install root,
    // including the slack adapter's manifest and entry stub.
    expect(await pathExists(path.join(expectedInstallRoot, '.dork', 'manifest.json'))).toBe(true);
    expect(
      await pathExists(
        path.join(expectedInstallRoot, '.dork', 'adapters', 'slack', 'manifest.json')
      )
    ).toBe(true);

    // The flow must register the adapter with AdapterManager.addAdapter,
    // passing the slack adapter's on-disk plugin path.
    expect(spies.adapterAdd).toHaveBeenCalledTimes(1);
    const addArgs = spies.adapterAdd.mock.calls[0];
    expect(addArgs?.[0]).toBe('slack');
    expect(addArgs?.[1]).toBe('valid-adapter');
    expect(addArgs?.[2]).toEqual({
      pluginPath: path.join(expectedInstallRoot, '.dork', 'adapters', 'slack'),
    });

    // A successful install must never call the compensating `removeAdapter`.
    expect(spies.adapterRemove).not.toHaveBeenCalled();
    expect(spies.templateClone).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Roundtrip test — drives the full install → update → uninstall lifecycle
  // through one MarketplaceInstaller against a real fixture and asserts that
  // each step actually sees the package the previous step produced. This is
  // the missing contract test that closes the manifest-format gap (issue #1
  // from the Session 2 code review): if any flow ever drifts from
  // `.dork/manifest.json` again, this test breaks immediately.
  // ---------------------------------------------------------------------------
  it('install → update → uninstall roundtrip preserves install metadata across the full lifecycle', async () => {
    const { installer } = buildInstallerForTests(dorkHome);

    // 1. Install fresh.
    const installResult = await installer.install({
      name: fixturePath('valid-skill-pack'),
    });
    expect(installResult.ok).toBe(true);
    const installRoot = installResult.installPath;

    // 2. The install pipeline must have written `.dork/manifest.json` (the
    //    canonical manifest) AND `.dork/install-metadata.json` (the
    //    provenance sidecar). Both files are required for the update flow
    //    and the uninstall flow to find this package on subsequent calls.
    expect(await pathExists(path.join(installRoot, '.dork', 'manifest.json'))).toBe(true);
    expect(await pathExists(path.join(installRoot, '.dork', 'install-metadata.json'))).toBe(true);

    const metadataRaw = await readFile(
      path.join(installRoot, '.dork', 'install-metadata.json'),
      'utf-8'
    );
    const metadata: Record<string, unknown> = JSON.parse(metadataRaw) as Record<string, unknown>;
    expect(metadata.name).toBe('valid-skill-pack');
    expect(metadata.type).toBe('skill-pack');
    expect(metadata.version).toBe('1.0.0');
    expect(typeof metadata.installedAt).toBe('string');
    // Local-path installs have no marketplace, so installedFrom is absent.
    expect(metadata.installedFrom).toBeUndefined();

    // 3. Plant some user state inside the install root that the data
    //    preservation contract must protect across the update.
    await mkdir(path.join(installRoot, '.dork', 'data'), { recursive: true });
    await writeFile(
      path.join(installRoot, '.dork', 'data', 'state.json'),
      '{"important":"keep me"}',
      'utf-8'
    );
    await writeFile(path.join(installRoot, '.dork', 'secrets.json'), '{"token":"shh"}', 'utf-8');

    // 4. Uninstall (no purge). The flow must locate the package via
    //    `.dork/manifest.json` (NOT `dork-package.json`) — if the lookup
    //    is broken, this throws PackageNotInstalledError. The data files
    //    we planted must be preserved.
    const uninstallResult = await installer['deps'].uninstallFlow.uninstall({
      name: 'valid-skill-pack',
    });
    expect(uninstallResult.ok).toBe(true);
    expect(uninstallResult.preservedData.length).toBeGreaterThan(0);

    // 5. The user state survived.
    expect(await pathExists(path.join(installRoot, '.dork', 'data', 'state.json'))).toBe(true);
    expect(await pathExists(path.join(installRoot, '.dork', 'secrets.json'))).toBe(true);
  });

  // Apply-mode update path: install → installer.update() → fresh install
  // lands at the same install root with the user's `.dork/data/` and
  // `.dork/secrets.json` preserved. This is the contract documented by
  // ADR-0233 and the fix for issue #2 from the Session 2 code review.
  it('installer.update() reinstalls cleanly while preserving user data and secrets', async () => {
    const { installer } = buildInstallerForTests(dorkHome);

    // First install.
    const firstInstall = await installer.install({
      name: fixturePath('valid-skill-pack'),
    });
    const installRoot = firstInstall.installPath;

    // Plant user state that the data preservation contract must protect.
    await mkdir(path.join(installRoot, '.dork', 'data'), { recursive: true });
    await writeFile(
      path.join(installRoot, '.dork', 'data', 'preserve-me.json'),
      '{"v":42}',
      'utf-8'
    );
    await writeFile(
      path.join(installRoot, '.dork', 'secrets.json'),
      '{"key":"secret-value"}',
      'utf-8'
    );

    // Apply-mode update against the same fixture (simulates a "no-op
    // version bump" where the user explicitly opted into a reinstall).
    // Without the uninstall-then-install fix, this throws ENOTEMPTY at
    // the rename step because the previous install root is still on disk.
    // The orchestrator's `update()` runs the resolver first so it can
    // pass the canonical package name (`valid-skill-pack`) — derived
    // from the fixture path — to the uninstall flow's name-based lookup.
    const updateResult = await installer.update({
      name: fixturePath('valid-skill-pack'),
    });
    expect(updateResult.ok).toBe(true);
    expect(updateResult.installPath).toBe(installRoot);

    // The fresh install landed and the user state survived.
    expect(await pathExists(path.join(installRoot, '.dork', 'manifest.json'))).toBe(true);
    expect(await pathExists(path.join(installRoot, '.dork', 'install-metadata.json'))).toBe(true);
    expect(await pathExists(path.join(installRoot, '.dork', 'data', 'preserve-me.json'))).toBe(
      true
    );
    const preservedState = await readFile(
      path.join(installRoot, '.dork', 'data', 'preserve-me.json'),
      'utf-8'
    );
    expect(JSON.parse(preservedState)).toEqual({ v: 42 });

    expect(await pathExists(path.join(installRoot, '.dork', 'secrets.json'))).toBe(true);
    const preservedSecrets = await readFile(
      path.join(installRoot, '.dork', 'secrets.json'),
      'utf-8'
    );
    expect(JSON.parse(preservedSecrets)).toEqual({ key: 'secret-value' });
  });
});
