/**
 * Shared test wiring for a full {@link MarketplaceInstaller}.
 *
 * Every collaborator is the real implementation rooted at a temp `dorkHome` —
 * resolver, cache, fetcher, validator, permission preview builder, conflict
 * detector, all five type-specific install flows, the uninstall flow, and the
 * file-scoped transaction engine. Only the external side-effect surfaces are
 * stubbed, because each of them reaches out of the install pipeline entirely:
 *
 * - `templateDownloader.cloneRepository` — the network. A throwing stub by
 *   default, so a test that accidentally leaves the local-fixture path fails
 *   loudly instead of hitting git.
 * - `extensionCompiler.compile` / `extensionManager.enable` / `.disable` /
 *   `.forgetRunApproval` — the extension subsystem.
 * - `agentCreator.createAgentWorkspace` — the real one pulls in configManager,
 *   boundary validation, and mesh sync.
 * - `AdapterManager` — the real class pulls in the whole relay subsystem.
 *
 * Each stub is a `vi.fn()` returned on {@link InstallerTestHarness.spies}, so a
 * test can both assert it fired and give it behaviour of its own.
 *
 * This file is not a test — it holds no `describe`, and the server's vitest
 * config collects only `*.test.ts`, so importing it never re-runs another
 * file's suite.
 *
 * @module services/marketplace/__tests__/installer-harness
 */
import { vi } from 'vitest';
import { noopLogger, type Logger } from '@dorkos/shared/logger';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { AgentCreationResult } from '../../core/agent-creator.js';
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
import { ShapeInstallFlow } from '../flows/install-shape.js';
import { SkillPackInstallFlow } from '../flows/install-skill-pack.js';
import { UninstallFlow } from '../flows/uninstall.js';

/**
 * The stubbed side-effect surfaces, exposed so a test can assert which ones
 * fired and can give any of them behaviour (a throw, a delay, a barrier).
 */
export interface InstallerTestSpies {
  extensionCompile: ReturnType<typeof vi.fn>;
  extensionEnable: ReturnType<typeof vi.fn>;
  /** Called by the uninstall flow for each bundled extension it removes. */
  extensionDisable: ReturnType<typeof vi.fn>;
  createAgentWorkspace: ReturnType<typeof vi.fn>;
  adapterAdd: ReturnType<typeof vi.fn>;
  adapterRemove: ReturnType<typeof vi.fn>;
  templateClone: ReturnType<typeof vi.fn>;
}

/** Everything {@link buildInstallerForTests} hands back. */
export interface InstallerTestHarness {
  installer: MarketplaceInstaller;
  dorkHome: string;
  spies: InstallerTestSpies;
  logger: Logger;
  /** Exposed so tests can spy on `fetchFromGit` without reaching into private fields. */
  fetcher: PackageFetcher;
  /** Exposed so tests can stub `resolve` to return a git-kind descriptor. */
  resolver: PackageResolver;
}

/**
 * Wire a full {@link MarketplaceInstaller} with real collaborators rooted at
 * the supplied temp `dorkHome` (see the module header for what is stubbed).
 *
 * @param dorkHome - Temp data directory every install writes under.
 * @returns The installer plus the stub spies and the two collaborators tests
 *   reach for directly.
 */
export function buildInstallerForTests(dorkHome: string): InstallerTestHarness {
  const logger = noopLogger;

  // Marketplace cache + source manager — both just need a dorkHome. They are
  // exercised lightly because local-path fixtures resolve as `kind: 'local'`,
  // bypassing marketplace lookup. Wired in anyway so the full graph runs.
  const sourceManager = new MarketplaceSourceManager(dorkHome);
  const cache = new MarketplaceCache(dorkHome);

  const templateClone = vi.fn(async () => {
    throw new Error('templateDownloader.cloneRepository must not be called for local fixtures');
  });
  const templateDownloader = {
    cloneRepository: templateClone,
  } as unknown as TemplateDownloader;

  const fetcher = new PackageFetcher(cache, templateDownloader, logger);
  const resolver = new PackageResolver(sourceManager, cache);

  // Adapter manager stub — just enough surface for ConflictDetector
  // (`listAdapters`) and the adapter install/uninstall paths (`addAdapter`,
  // `removeAdapter`).
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

  // Extension compiler / manager stubs — structural interfaces mirrored by
  // `ExtensionCompilerLike` / `ExtensionManagerLike` in install-plugin.ts.
  const extensionCompile = vi
    .fn()
    .mockResolvedValue({ code: 'compiled', sourceHash: 'installer-harness' });
  const extensionEnable = vi.fn().mockResolvedValue({ extension: {}, reloadRequired: false });
  const extensionDisable = vi.fn().mockResolvedValue(undefined);
  const extensionCompiler = { compile: extensionCompile };
  const extensionManager = {
    enable: extensionEnable,
    disable: extensionDisable,
    forgetRunApproval: vi.fn().mockResolvedValue(undefined),
  };

  // Agent creator stub. Its input is `unknown` because the real creator
  // Zod-parses whatever it is handed, and the agent flow awaits the result
  // without reading it — so the returned manifest only has to be a manifest by
  // type, which is what the cast records.
  const createAgentWorkspace = vi.fn(async (input: unknown): Promise<AgentCreationResult> => {
    const { directory, name } = input as { directory: string; name: string };
    return {
      manifest: { id: 'installer-harness-agent-id', name } as unknown as AgentManifest,
      path: directory,
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
  const agentFlow = new AgentInstallFlow({ dorkHome, agentCreator, logger });
  const skillPackFlow = new SkillPackInstallFlow({ dorkHome, logger });
  const adapterFlow = new AdapterInstallFlow({ dorkHome, adapterManager, logger });
  const shapeFlow = new ShapeInstallFlow({ dorkHome, extensionCompiler, logger });
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
    shapeFlow,
    uninstallFlow,
    logger,
  });

  return {
    installer,
    dorkHome,
    logger,
    fetcher,
    resolver,
    spies: {
      extensionCompile,
      extensionEnable,
      extensionDisable,
      createAgentWorkspace,
      adapterAdd,
      adapterRemove,
      templateClone,
    },
  };
}
