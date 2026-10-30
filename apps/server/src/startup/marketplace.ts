/**
 * The marketplace at startup: its sources, cache and install flows, the
 * package routes and what the shapes routes read, the dev-link watcher, the
 * personal marketplace, and the tools the external `/mcp` server gets for it
 * (DOR-2821, moved out of `index.ts` unchanged).
 *
 * Needs both the extension manager and the adapter manager; without either it
 * says so once and mounts nothing.
 *
 * @module startup/marketplace
 */
import path from 'path';
import { existsSync } from 'node:fs';
import { HARNESS_MANIFEST_PATH } from '@dorkos/harness';
import { ClaudeCodeRuntime } from '../services/runtimes/claude-code/claude-code-runtime.js';
import { configManager } from '../services/core/config-manager.js';
import { logConfigWrite } from '../services/core/operator/config-write.js';
import { logger, logError } from '../lib/logger.js';
import { AdapterManager } from '../services/relay/adapter-manager.js';
import { MeshCore } from '@dorkos/mesh';
import { ExtensionManager } from '../services/extensions/extension-manager.js';
import { broadcastExtensionReloaded } from '../routes/extensions.js';
import { createAgentWorkspace } from '../services/core/agent-creator.js';
import { gitTreeSource } from '../services/marketplace/lib/git/git-tree.js';
import { MarketplaceSourceManager } from '../services/marketplace/sources/marketplace-source-manager.js';
import { MarketplaceCache } from '../services/marketplace/cache/marketplace-cache.js';
import { PackageCacheRetention } from '../services/marketplace/cache/package-cache-retention.js';
import { PackageResolver } from '../services/marketplace/package-resolver.js';
import { rebuildInstalledFiles } from '../services/marketplace/lib/records/legacy-record.js';
import {
  legacySweepDirs,
  rebuildLegacyRecords,
  removeRecordTempLeftovers,
  logLegacySweep,
} from '../services/marketplace/lib/integrity/legacy-record-sweep.js';
import { PackageFetcher } from '../services/marketplace/package-fetcher.js';
import { ConflictDetector } from '../services/marketplace/preview/conflict-detector.js';
import { PermissionPreviewBuilder } from '../services/marketplace/preview/permission-preview.js';
import { PluginInstallFlow } from '../services/marketplace/flows/install-plugin.js';
import { AgentInstallFlow } from '../services/marketplace/flows/install-agent.js';
import { SkillPackInstallFlow } from '../services/marketplace/flows/install-skill-pack.js';
import { AdapterInstallFlow } from '../services/marketplace/flows/install-adapter.js';
import { ShapeInstallFlow } from '../services/marketplace/flows/install-shape.js';
import type { HonoApiDeps } from '../http/hono-api.js';
import {
  applyShape,
  type ApplyShapeDeps,
  type ShapeScheduleServiceLike,
} from '../services/shapes/apply-shape.js';
import {
  clearActiveShape,
  createFsShapeManifestResolver,
  createShapeConfigStore,
  createShapeSecretChecker,
  getActiveShapeName,
  getEnabledExtensionIds,
} from '../services/shapes/shape-services.js';
import { UninstallFlow } from '../services/marketplace/flows/uninstall/uninstall.js';
import {
  DevLinkService,
  DevLinkWatcher,
  devLinkExtensionsOf,
  hookDecisionConsentStore,
} from '../services/marketplace/dev-links/index.js';
import { createMeshAgentRegistry } from '../services/marketplace/flows/mesh-agent-registry.js';
import { UpdateFlow } from '../services/marketplace/flows/update.js';
import { MarketplaceInstaller } from '../services/marketplace/installer/marketplace-installer.js';
import { projectAgainAfterYes, runAutoProjection } from '../services/harness/auto-project.js';
import { resumePassiveHookRows } from '../services/harness/ask-withheld-hooks.js';
import { globalConsentRecorder } from '../services/marketplace/consent/global-plugin-consent.js';
import { askAboutWithheldGlobalPlugins } from '../services/marketplace/consent/ask-withheld-global-plugins.js';
import { ensurePersonalMarketplace } from '../services/marketplace-mcp/personal-marketplace.js';
import {
  TokenConfirmationProvider,
  type ConfirmationProvider,
} from '../services/marketplace-mcp/confirmation-provider.js';
import type { MarketplaceMcpDeps } from '../services/marketplace-mcp/marketplace-mcp-tools.js';
import { ApprovalService } from '../services/core/approvals/index.js';
import { type CapabilityRegistry } from '../services/core/capabilities/index.js';
import { eventFanOut } from '../services/core/event-fan-out.js';
import { operatorAudience } from '../services/notifications/notification-entitlement.js';
import { currentServerRole } from '../lib/server-role.js';
import { isPersonalComputer } from '../services/core/server-role/role-checks.js';

/** What starting the marketplace needs from the startup that came before it. */
export interface MarketplaceStartupDeps {
  /** The resolved DorkOS data directory. */
  dorkHome: string;
  /** The extension manager, when extensions initialized. */
  extensionManager: ExtensionManager | undefined;
  /** The adapter manager, when relay started. */
  adapterManager: AdapterManager | undefined;
  /** The Claude Code runtime, or `null` on a test server. */
  claudeRuntime: ClaudeCodeRuntime | null;
  /** Pending approvals. */
  approvalService: ApprovalService;
  /** Schedules a shape brings with it. */
  shapeScheduleService: ShapeScheduleServiceLike;
  /** Interrupted installs being settled, which the legacy-record sweep waits for. */
  projectInstallRecovery: Promise<unknown>;
  /** Cancels the legacy-record sweep at shutdown. */
  legacyRecordSweep: AbortController;
  /** The agent registry as `index.ts` holds it now, read at each use. */
  currentMeshCore: () => MeshCore | undefined;
  /** The projects the install recovery swept, read once it has finished. */
  currentSweptProjects: () => string[];
  /** The capability registry, composed after this runs and read at each use. */
  currentCapabilityRegistry: () => CapabilityRegistry | undefined;
  /** The names of the routers mounted so far, for the boot log line. */
  mountedRouters: string[];
  /**
   * What the Hono `/api` app reads; this sets `marketplace` and `shapes` when
   * the marketplace starts.
   */
  honoDeps: HonoApiDeps;
}

/** What `index.ts` keeps from the marketplace, all absent when it did not start. */
export interface StartedMarketplace {
  /** Watches dev-linked packages. */
  devLinkWatcher: DevLinkWatcher | undefined;
  /** Confirms template installs. */
  templateConfirmationProvider: ConfirmationProvider | undefined;
  /** Installs an agent package, for agent creation from a template. */
  agentPackageInstaller: { installer: MarketplaceInstaller; dorkHome: string } | undefined;
  /** The marketplace tools for the external `/mcp` server. */
  marketplaceMcpDeps: MarketplaceMcpDeps | undefined;
}

/**
 * Start the marketplace, when both the extension manager and the adapter
 * manager are up.
 *
 * @param deps - See {@link MarketplaceStartupDeps}.
 * @returns See {@link StartedMarketplace}.
 */
export async function startMarketplace(deps: MarketplaceStartupDeps): Promise<StartedMarketplace> {
  const {
    dorkHome,
    extensionManager,
    adapterManager,
    claudeRuntime,
    approvalService,
    shapeScheduleService,
    projectInstallRecovery,
    legacyRecordSweep,
    currentMeshCore,
    currentSweptProjects,
    currentCapabilityRegistry,
    mountedRouters,
  } = deps;
  let devLinkWatcher: DevLinkWatcher | undefined;
  let templateConfirmationProvider: ConfirmationProvider | undefined;
  let agentPackageInstaller: StartedMarketplace['agentPackageInstaller'];
  let marketplaceMcpDeps: MarketplaceMcpDeps | undefined;
  if (extensionManager && adapterManager) {
    const marketplaceSourceManager = new MarketplaceSourceManager(dorkHome);
    const marketplaceCache = new MarketplaceCache(dorkHome);
    // Reclaim what no cache entry is read from: trees cached before their
    // keys were verified (DOR-2248) and temp fetches a crash left behind.
    // Awaited, before the routes exist, so it can never race a fetch.
    try {
      await marketplaceCache.removeLeftovers();
    } catch (err) {
      logger.warn('[Marketplace] could not clear leftover package cache files', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const marketplaceFetcher = new PackageFetcher(marketplaceCache, gitTreeSource, logger);
    // Give packages an older DorkOS installed an exact installed-files record,
    // in the background once interrupted installs are settled (DOR-2197). It
    // never blocks startup and writes nothing it cannot prove; what it cannot
    // rebuild waits for the next boot or the "Check files" action.
    void projectInstallRecovery
      .then(() => removeRecordTempLeftovers())
      .then(() =>
        rebuildLegacyRecords(
          legacySweepDirs(dorkHome, currentSweptProjects()),
          { fetcher: marketplaceFetcher, logger },
          { signal: legacyRecordSweep.signal }
        )
      )
      .then(logLegacySweep)
      .catch((err: unknown) => {
        logger.warn('[Marketplace] Rebuilding records for older installs failed', logError(err));
      });
    const marketplaceResolver = new PackageResolver(marketplaceSourceManager, marketplaceCache);
    const marketplaceConflictDetector = new ConflictDetector(dorkHome, adapterManager);
    const marketplacePreviewBuilder = new PermissionPreviewBuilder(
      dorkHome,
      marketplaceConflictDetector
    );

    const marketplacePluginFlow = new PluginInstallFlow({
      dorkHome,
      extensionCompiler: extensionManager.getCompiler(),
      extensionManager,
      logger,
    });
    // One agent-registry surface for the flows that take an agent off the team
    // (DOR-2245): an uninstalled agent package, and an agent a different
    // package with the same name replaces.
    const marketplaceAgentRegistry = createMeshAgentRegistry(() => currentMeshCore());
    const marketplaceAgentFlow = new AgentInstallFlow({
      dorkHome,
      agentCreator: { createAgentWorkspace },
      getMeshCore: () => currentMeshCore(),
      agentRegistry: marketplaceAgentRegistry,
      logger,
    });
    const marketplaceSkillPackFlow = new SkillPackInstallFlow({ dorkHome, logger });
    const marketplaceAdapterFlow = new AdapterInstallFlow({
      dorkHome,
      adapterManager,
      logger,
    });
    const marketplaceShapeFlow = new ShapeInstallFlow({
      dorkHome,
      extensionCompiler: extensionManager.getCompiler(),
      logger,
    });
    const marketplaceUninstallFlow = new UninstallFlow({
      dorkHome,
      extensionManager,
      adapterManager,
      // Keep `ui.shapes.active` honest when the active Shape is uninstalled.
      shapeDeactivator: { getActiveShapeName, clearActiveShape },
      // Delete the schedules a removed Shape created so its tick stops firing.
      shapeScheduleTeardown: shapeScheduleService,
      // An uninstalled agent package's agent leaves the team (DOR-2245): the
      // full unregister cascade, and back again if the uninstall rolls back.
      agentRegistry: marketplaceAgentRegistry,
      // An install made before installed-files records existed gets one rebuilt
      // from the commit it was installed at (DOR-2245 §9).
      rebuildLegacy: (installRoot: string) =>
        rebuildInstalledFiles(installRoot, { fetcher: marketplaceFetcher, logger }),
      logger,
    });

    // Shape apply wiring (DOR-355) — constructed here, before the installer,
    // because the installer's update() path re-applies the active Shape after
    // an uninstall → reinstall replace. The `/api/shapes` routes set up below
    // share these exact deps; `shapeScheduleService` is the hoisted instance
    // the agent-create re-bind seam also uses (built above the agents router).
    const shapeApplyDeps: ApplyShapeDeps = {
      manifestResolver: createFsShapeManifestResolver(dorkHome),
      extensionManager,
      secretChecker: createShapeSecretChecker(dorkHome),
      agentRegistry: { listWithPaths: () => currentMeshCore()?.listWithPaths() ?? [] },
      scheduleService: shapeScheduleService,
      configStore: createShapeConfigStore(),
    };

    const marketplaceInstaller = new MarketplaceInstaller({
      dorkHome,
      resolver: marketplaceResolver,
      fetcher: marketplaceFetcher,
      previewBuilder: marketplacePreviewBuilder,
      pluginFlow: marketplacePluginFlow,
      agentFlow: marketplaceAgentFlow,
      skillPackFlow: marketplaceSkillPackFlow,
      adapterFlow: marketplaceAdapterFlow,
      shapeFlow: marketplaceShapeFlow,
      uninstallFlow: marketplaceUninstallFlow,
      // Updating the active Shape keeps its pointer through the replace and
      // re-applies the new version so the cockpit reflects the update.
      shapeUpdateHooks: {
        getActiveShapeName,
        reapplyShape: (name) => applyShape(name, shapeApplyDeps),
      },
      logger,
    });

    // UpdateFlow takes an `InstallerLike` — passing the concrete installer
    // is safe because `MarketplaceInstaller implements InstallerLike` and
    // breaks the type cycle between installer and update flow at the type
    // level (see `marketplace-installer.ts`).
    const marketplaceUpdateFlow = new UpdateFlow({
      dorkHome,
      installer: marketplaceInstaller,
      sourceManager: marketplaceSourceManager,
      fetcher: marketplaceFetcher,
      logger,
    });

    // Cross-scope installed listing walks every registered agent's
    // .dork/plugins. Resolved lazily per call so agents registered after
    // startup are included; display name preferred for the UI. Shared by the
    // HTTP router and the `marketplace_list_installed` MCP tool so both report
    // the same one-entry-per-installation truth.
    const listAgentScopes = () =>
      (currentMeshCore()?.listWithPaths() ?? []).map((a) => ({
        projectPath: a.projectPath,
        id: a.id,
        name: a.displayName ?? a.name,
      }));

    // The package cache's retention owner (DOR-2249): sweeps after every new
    // entry and once now, in the background, keeping what installs need.
    const marketplaceCacheRetention = new PackageCacheRetention({
      cache: marketplaceCache,
      dorkHome,
      // No registry means agent-scoped installs are invisible, so the sweep
      // must remove nothing rather than read that as "none installed".
      listAgentScopes: () => (currentMeshCore() ? listAgentScopes() : undefined),
      logger,
    });
    marketplaceCacheRetention.start();

    // Ask a person about every global package held back from sessions because
    // nobody approved what it runs (DOR-2306). Fire-and-forget: a card stays
    // open for the approval window, and a yes reloads the plugins sessions get.
    const askAboutWithheldGlobals = (): void => {
      askAboutWithheldGlobalPlugins({
        dorkHome,
        approvals: approvalService,
        onGranted: () => claudeRuntime?.refreshActivatedPlugins(),
      }).catch((err) => {
        logger.warn('[Marketplace] Asking about held-back global packages failed', { err });
      });
    };
    // Once at start: packages installed before this version, or changed on disk
    // while DorkOS was off, are asked about now rather than at the next install.
    askAboutWithheldGlobals();

    // The one post-change notifier, handed to BOTH surfaces that mutate installed
    // packages: the HTTP router below and the marketplace MCP tools
    // (`marketplaceMcpDeps`). It is required on both deps types, so a surface
    // cannot be wired without it — an agent's `marketplace_install` used to skip
    // it entirely and leave the plugin unprojected (DOR-2057).
    // The runtime half of the post-change notifier, on its own so the dev link
    // watcher can refresh plugins without also queuing a projection per edit.
    // Resolves when the refresh is done, and never rejects.
    const refreshRuntimePlugins = (projectPath: string | undefined): Promise<void> => {
      // Pass the project path (when the change was project-scoped) so the
      // runtime drops that cwd's cached command list and re-warms it with
      // the merged per-cwd plugin set.
      const refreshed =
        claudeRuntime?.refreshActivatedPlugins(projectPath).catch((err) => {
          logger.warn('[Marketplace] Post-install plugin refresh failed', { err });
        }) ?? Promise.resolve();
      // A global change can leave a package held back from every session until
      // a person approves what it runs (DOR-2306): ask now, in the background.
      if (projectPath === undefined) askAboutWithheldGlobals();
      return refreshed;
    };

    const onPluginsChanged: MarketplaceMcpDeps['onPluginsChanged'] = (ctx) => {
      // Never throws into the caller: it runs after a mutation already succeeded,
      // and a failed follow-up must not be reported as a failed install.
      try {
        void refreshRuntimePlugins(ctx.projectPath);
        // Harness Sync auto-projection (GAP-4): project the changed plugin's
        // assets to the project's other harnesses. Fire-and-forget; the
        // service is internally best-effort and never throws, but we still
        // catch here to honor the no-floating-promise convention.
        runAutoProjection(ctx, { dorkHome, approvals: approvalService }).catch((err) => {
          logger.warn('[Marketplace] Harness auto-projection failed', { err });
        });
      } catch (err) {
        logger.warn('[Marketplace] Post-change notification failed', { err });
      }
    };

    // A quiet Needs-you row left open by the last run is waited on again, so a
    // yes given after the restart records and projects (DOR-3427).
    // Never fatal: a start that cannot pick the rows up still starts.
    try {
      resumePassiveHookRows({
        dorkHome,
        approvals: approvalService,
        reproject: (request) =>
          projectAgainAfterYes(
            {
              projectPath: request.projectPath,
              packageName: request.packageName,
              action: 'install',
            },
            dorkHome
          ),
      });
    } catch (err) {
      logger.warn('[Marketplace] Could not pick up the saved quiet rows', { err });
    }

    // Running extensions' skills (DOR-2685): when the set of extension skills
    // agents should see changes, project each affected project again (the same
    // consent seam and `harness.autoSync` gate a plugin install goes through)
    // and refresh the plugins Claude Code sessions load for global ones. A
    // project an extension only LEFT and that has no harness manifest has
    // nothing projected to sweep, so it is not scaffolded one.
    extensionManager?.attachSkillDelivery({
      projectChanged: async ({ root, ids, remaining }) => {
        if (!remaining && !existsSync(path.join(root, HARNESS_MANIFEST_PATH))) return;
        await runAutoProjection(
          {
            projectPath: root,
            packageName: ids.join(', '),
            action: remaining ? 'install' : 'uninstall',
          },
          { dorkHome, approvals: approvalService }
        );
        claudeRuntime?.refreshProjectCommands(root);
      },
      globalChanged: () => claudeRuntime?.refreshActivatedPlugins(),
    });

    // Dev links (DOR-2696): run a plugin or skill pack from a folder. One
    // service for the routes and the `marketplace_link` capability. A link's
    // yes for the extensions it carries is written beside every other
    // extension approval, keeping the rest of that section as it is.
    const devLinkExtensions = extensionManager;
    // An edit in a linked folder reaches DorkOS within seconds, through the
    // seams an install uses (spec §6). It records no approval: a rebuild needs
    // the extension already approved, and anything new asks on its own card.
    devLinkWatcher = new DevLinkWatcher({
      dorkHome,
      extensions: devLinkExtensionsOf(devLinkExtensions, {
        config: () => configManager.get('extensions'),
        announce: (ids) => broadcastExtensionReloaded(ids),
      }),
      // Global dev links only: a project package is not an SDK plugin, so a
      // project dev link's edits reach sessions through the projection alone.
      refreshPlugins: () => refreshRuntimePlugins(undefined),
      reproject: (ctx) =>
        runAutoProjection({ ...ctx, action: 'install' }, { dorkHome, approvals: approvalService }),
      refreshProjectCommands: (projectPath) => claudeRuntime?.refreshProjectCommands(projectPath),
      // A person's surface: it names folders and build errors, so it goes
      // where `config_changed` goes and no agent reads it.
      broadcast: (event) =>
        eventFanOut.broadcast('marketplace_dev_link_reloaded', event, operatorAudience),
    });
    const devLinkService = new DevLinkService({
      dorkHome,
      approvals: {
        read: () => {
          const extensions = configManager.get('extensions');
          return {
            approvedToRun: extensions.approvedToRun,
            approvedSources: extensions.approvedSources ?? {},
            approvedPermissions: extensions.approvedPermissions ?? {},
          };
        },
        write: (next) => {
          const before = configManager.get('extensions');
          configManager.set('extensions', { ...before, ...next });
          logConfigWrite('linking a folder', 'extensions', before, configManager.get('extensions'));
        },
      },
      // The link card's yes for the hooks and programs it showed (task 2.2).
      consent: hookDecisionConsentStore,
      onPluginsChanged,
      refreshExtensions: () => devLinkExtensions.requestRefresh(),
      reloads: devLinkWatcher,
    });
    // Not awaited: boot does not wait on watches opening. It never rejects.
    void devLinkWatcher.start();

    // Build the confirmation provider that gates marketplace mutations. There is
    // exactly one, and no way to switch it off: it records an approval the
    // operator decides from the approval card (`POST /api/approvals/:id/grant|deny`).
    // Automation answers that approval through the same routes a person uses
    // rather than skipping it (DOR-501). Shared by the MCP tools and the HTTP
    // update route, so an agent's update raises the same card on both (DOR-2306).
    const confirmationProvider: ConfirmationProvider = new TokenConfirmationProvider(
      approvalService
    );
    templateConfirmationProvider = confirmationProvider;
    agentPackageInstaller = { installer: marketplaceInstaller, dorkHome };

    // The marketplace routes (`/api/marketplace`), served from the Hono `/api`
    // app with what this sets on `honoDeps`; never mounted when the marketplace
    // did not start.
    deps.honoDeps.marketplace = {
      // Read lazily: the registry is composed further down this same boot, so
      // a direct reference here would capture `undefined` forever. Until it
      // exists, the marketplace mutation routes fail closed.
      capabilityRegistry: currentCapabilityRegistry,
      sourceManager: marketplaceSourceManager,
      cache: marketplaceCache,
      cacheRetention: marketplaceCacheRetention,
      fetcher: marketplaceFetcher,
      installer: marketplaceInstaller,
      uninstallFlow: marketplaceUninstallFlow,
      updateFlow: marketplaceUpdateFlow,
      dorkHome,
      listAgentScopes,
      onPluginsChanged,
      confirmationProvider,
      consent: globalConsentRecorder,
      heldBackCards: {
        approvals: approvalService,
        onGranted: () => claudeRuntime?.refreshActivatedPlugins(),
      },
      devLinks: devLinkService,
    };
    mountedRouters.push('marketplace');

    // Shape routes (DOR-355), served from the Hono `/api` app with what this
    // sets on `honoDeps`. Apply/fork ride the marketplace block because apply
    // enables extensions (needs `extensionManager`). Schedules degrade to a
    // no-op when the scheduler is off; extensions, chrome, and agent offers
    // still apply. (`shapeApplyDeps` is constructed above the installer so the
    // update path can re-apply the active Shape.)
    deps.honoDeps.shapes = {
      dorkHome,
      applyDeps: shapeApplyDeps,
      forkDeps: {
        dorkHome,
        logger,
        getEnabledExtensions: getEnabledExtensionIds,
        getActiveShape: getActiveShapeName,
      },
    };
    mountedRouters.push('shapes');

    // Personal marketplace bootstrap — runs after the source manager is wired
    // but before the MCP server fields its first request so the personal
    // source is registered when external clients call
    // `marketplace_list_marketplaces`. Failure here is non-fatal: a missing
    // personal marketplace just means the `marketplace_create_package` tool
    // has no destination, every other tool keeps working.
    try {
      await ensurePersonalMarketplace({
        dorkHome,
        sourceManager: marketplaceSourceManager,
        logger,
      });
    } catch (err) {
      logger.warn('[personal-marketplace] bootstrap failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    marketplaceMcpDeps = {
      dorkHome,
      installer: marketplaceInstaller,
      sourceManager: marketplaceSourceManager,
      fetcher: marketplaceFetcher,
      cache: marketplaceCache,
      uninstallFlow: marketplaceUninstallFlow,
      updateFlow: marketplaceUpdateFlow,
      confirmationProvider,
      consent: globalConsentRecorder,
      onPluginsChanged,
      listAgentScopes,
      devLinks: devLinkService,
      logger,
    };
    logger.info('[Marketplace] MCP tools wired into external /mcp server');
  } else if (!isPersonalComputer()) {
    // A hub starts no chat app connections, so the adapter manager this needs
    // is never built. Whether a hub installs packages is the agent computers'
    // question (DOR-2939), not this server's. An agent computer starts none
    // either, and its packages will come from its hub.
    logger.info(
      `[Marketplace] ${currentServerRole()}: package installs are not served from this server`
    );
  } else {
    logger.warn(
      '[Marketplace] Routes skipped — requires extensionManager and adapterManager (relay must be enabled and extensions must have initialized successfully)'
    );
  }
  return {
    devLinkWatcher,
    templateConfirmationProvider,
    agentPackageInstaller,
    marketplaceMcpDeps,
  };
}
