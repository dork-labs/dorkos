import { localBrowserHost } from './startup/local-browser.js';
import { startMainListener } from './services/core/lifecycle/main-listener.js';
import { MainRequestAdmission } from './services/core/lifecycle/main-request-admission.js';
import { createFrontDoorServer, frontDoorListener } from './http/front-door.js';
import { startTlsListener } from './http/tls-listener.js';
import { resolveDorkHome } from './lib/dork-home.js';
import { composeFrontDoor } from './http/hono-api.js';
import { shutdownRuntimes } from './startup/shutdown-runtimes.js';
import { previewListeners } from './services/workbench-serve/index.js';
import { runtimeRegistry } from './services/core/runtime-registry.js';
import { canExpose, checkBindAllowed } from './services/core/auth/exposure-guard.js';
import { tunnelManager } from './services/core/tunnel-manager.js';
import { lanAccess } from './services/core/lan-access/index.js';
import { exitOnPortConflict } from './services/core/lifecycle/port-conflict.js';
import { createSignalShutdown } from './lib/shutdown-signal.js';
import { getCloudLinkManager } from './services/core/auth/cloud-link.js';
import { stopCreditsLifecycle } from './services/core/cloud/credits-inference.js';
import { configManager } from './services/core/config-manager.js';
import { logger, logError } from './lib/logger.js';
import {
  captureLiveStandingGrants,
  readStandingGrantLicence,
} from './services/core/permissions/index.js';
import { managedRemoteCommands } from './services/core/remote/managed-command-service.js';
import { currentRemoteBootPlan } from './services/core/remote/remote-boot.js';
import { installSweepLogger } from './services/marketplace/recovery/install-sweep-log.js';
import { setRemoteCommunitySubscriptionProbe } from './routes/test-control.js';
import { runMigrations, DatabaseOpenError, SnapshotFailedError, agents } from '@dorkos/db';
import { ownerNoticeSweep } from './services/notifications/emitters/community-owner-notice-sweep.js';
import { SERVER_VERSION } from './lib/version.js';
import {
  createWorkspaceSubsystem,
  WorkspaceReconcilerLifecycle,
  resolveWorkspaceRoot,
  setWorkspaceManager,
  setWorkspaceApprovals,
  setWorkspaceRoot,
} from './services/workspace/index.js';
import { terminalUpgradeRoute } from './services/terminal/index.js';
import { attachUpgradeRouter } from './services/core/streams/upgrade-router.js';
import { tunnelIngressesFor } from './services/core/remote/tunnel-ingresses.js';
import { durableStreamRoutes } from './routes/stream-sockets.js';
import {
  closeAllComputerConnections,
  hubRelayComputerRoute,
} from './services/core/hub-relay/index.js';
import { registerHeartbeat, type HeartbeatCounts } from './services/core/heartbeat-reporter.js';
import { shutdownUsageReporter } from './services/core/usage-reporter.js';
import { flushServerError, captureServerError } from './services/core/error-reporter.js';
import { shutdownAiMetadataReporter } from './services/core/ai-metadata-reporter.js';
import { resolveTelemetryConsent } from '@dorkos/shared/telemetry-consent';
import { keepAwakeService } from './services/core/keep-awake/index.js';
import { setAccountUsageStore } from './services/core/usage/current-usage-store.js';
import { shutdownObservability } from './services/observability/index.js';
import { sessionListBroadcaster } from './services/session/catalog/session-list-broadcaster.js';
import { getAgentSendService } from './services/extensions/agent-send/agent-send.js';
import * as heartbeats from './services/heartbeats/index.js';
import { aggregateSessionList } from './services/session/catalog/aggregate-session-list.js';
import { env } from './env.js';
import { claimDataDirectory } from './startup/steps/data-directory.js';
import { openConfigAndDatabase } from './startup/steps/config-and-database.js';
import { raiseExistingChatsOnBoot } from './startup/steps/raise-existing-chats.js';
import { recordKeptFromAutoMovesOnBoot } from './startup/steps/record-kept-from-auto-moves.js';
import { wireCoreStores } from './startup/steps/core-stores.js';
import { wireSessionServices } from './startup/steps/session-services.js';
import { startTelemetryExtensionsAndRuntimes } from './startup/steps/telemetry-extensions-runtimes.js';
import { wireRooms } from './startup/steps/rooms.js';
import { startSearchRelayAndMesh } from './startup/steps/search-relay-mesh.js';
import { wireTeamRoomAndRelayAdapters } from './startup/steps/team-room-relay-adapters.js';
import { wireConnectorEventsAndApprovals } from './startup/steps/connector-events-approvals.js';
import { wireConnectorServices } from './startup/steps/connector-services.js';
import { wireDocDelivery } from './startup/steps/doc-delivery.js';
import { wireMcpTasksAndSkills } from './startup/steps/mcp-tasks-skills.js';
import { mountCoreRoutes } from './startup/steps/core-routes.js';
import { mountLateRoutes } from './startup/steps/late-routes.js';
import { composeCapabilities } from './startup/steps/capabilities.js';
import { startAfterListen } from './startup/steps/after-listen.js';
import { createServerRefs, type ServerRefs } from './startup/server-refs.js';
import { currentServerRole } from './lib/server-role.js';

// The live tunnel manager, re-exported for the CLI that started this server.
//
// This module is the ONLY one the CLI and the server share at runtime. The CLI
// ships as two bundles — `dist/bin/cli.js` and `dist/server/index.js` — and
// only `../server/index.js` is left external, so it is a real import of the
// running server. Every other `apps/server/src` module the CLI reaches for is
// INLINED into the CLI bundle instead, which is how the startup tunnel printout
// came to listen to a second, never-started `TunnelManager` and never printed
// the address (DOR-1745). Anything the CLI needs from the process the server is
// actually running in has to come through here.
export { tunnelManager };

const PORT = env.DORKOS_PORT;

// The server's live references (`startup/server-refs.ts`). The three kept as plain
// variables below are read by name in `shutdownServices()` and the startup
// failure handler, so their fields here forward to those variables.
const refs: ServerRefs = {
  ...createServerRefs(),
  get stopDocDelivery() {
    return stopDocDelivery;
  },
  set stopDocDelivery(value) {
    stopDocDelivery = value;
  },
  get testComposioFixture() {
    return testComposioFixture;
  },
  set testComposioFixture(value) {
    testComposioFixture = value;
  },
  get docNotificationCleanup() {
    return docNotificationCleanup;
  },
  set docNotificationCleanup(value) {
    docNotificationCleanup = value;
  },
};
/** Stop document recovery before the SQLite connection is disposed. */
let stopDocDelivery: (() => Promise<void>) | undefined;
let testComposioFixture:
  | Awaited<
      ReturnType<
        typeof import('./services/connectors/providers/test-composio/fixture.js').startTestComposioFixture
      >
    >
  | undefined;

/** Logs what an install-recovery sweep did (see `installSweepLogger`). */
const logInstallSweep = installSweepLogger(() => refs.meshCore);
/** Aborted on shutdown, so the legacy record sweep stops between installs. */
const legacyRecordSweep = new AbortController();
// Passive until workspace bootstrap; disposal stays terminal if startup resumes later.
const mainRequestAdmission = new MainRequestAdmission();
const workspaceReconcilerLifecycle = new WorkspaceReconcilerLifecycle();

async function start() {
  /**
   * Which optional routers this boot actually mounted, reported as ONE line.
   *
   * It used to be eleven `[X] Routes mounted` lines, which was eleven lines to
   * say "routes mounted" — a fifth of a healthy startup's whole output, none of
   * it varying, and none of it something anybody has ever read. What a person
   * wants to know is WHICH optional subsystems came up, and that is one line.
   */
  const mountedRouters: string[] = [];
  // KEEP IN SYNC with `bootInProcessTestServer()` in `harness-boot.ts`: the
  // eval harness mirrors the subset of this function's singleton wiring a
  // driven turn needs (config store, boundary, DB + session-event store,
  // runtime registration), with no compile-time link. If a new process-global
  // singleton lands here and the turn path reads it, wire it there too — the
  // harness's structural self-test is the tripwire that goes red on drift.
  //
  // Startup runs as a sequence of steps in `startup/steps/`, in the order the inline
  // code ran. Each step returns what it built; every `upTo…` object carries all of
  // it into the next step, and `refs` holds what shutdown needs.
  const fromIndex = { PORT, logInstallSweep, shutdownServices, legacyRecordSweep, mountedRouters };
  const upToDataDirectory = { ...fromIndex, ...(await claimDataDirectory(refs, fromIndex)) };
  const { dorkHome } = upToDataDirectory;

  // The retired standing-permission settings, which the capture below needs to
  // tell a live standing permission from a void one (`ended-standing-grants.ts`).
  // Nothing removes them until that capture is done.
  const standingGrantLicence = readStandingGrantLicence(dorkHome);
  const upToDatabase = {
    ...upToDataDirectory,
    ...(await openConfigAndDatabase(refs, upToDataDirectory)),
  };
  const { db, dbPath } = upToDatabase;
  // Standing permissions are retired and their table is dropped by the next
  // migration; the live ones are recorded first, so the permission sweep can
  // write one history line for each once the Activity log exists.
  captureLiveStandingGrants(db, dorkHome, logger, standingGrantLicence);
  runMigrations(db);
  // Only now may the settings the capture read go: see `retireStandingGrantSettings`.
  try {
    configManager.retireStandingGrantSettings();
  } catch (error) {
    logger.warn('[Permissions] could not remove the retired standing-permission settings', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  logger.info(`[DB] Consolidated database ready at ${dbPath}`);
  const upToCoreStores = { ...upToDatabase, ...(await wireCoreStores(refs, upToDatabase)) };
  const upToSessionServices = {
    ...upToCoreStores,
    ...(await wireSessionServices(refs, upToCoreStores)),
  };
  const upToRuntimes = {
    ...upToSessionServices,
    ...(await startTelemetryExtensionsAndRuntimes(refs, upToSessionServices)),
  };

  // Workspace subsystem (DOR-84) — server-managed isolated workspaces. Sessions
  // bind via cwd; the manager allocates collision-free port blocks and owns the
  // lifecycle. Attached sessions are resolved from the runtime's session list.
  const workspaceConfig = configManager.get('workspace');
  // The adoption scan reads the root directly, so it is registered whether or
  // not the managed layer is enabled: which checkouts exist on disk is true
  // either way, and that honesty is the whole point of the /workspaces page.
  setWorkspaceRoot(resolveWorkspaceRoot({ dorkHome, config: workspaceConfig }));
  if (workspaceConfig.enabled) {
    const {
      service: workspaceService,
      reconciler: workspaceReconciler,
      store: workspaceStore,
    } = createWorkspaceSubsystem({
      db,
      dorkHome,
      config: workspaceConfig,
      listAttachedSessions: async (workspacePath) => {
        try {
          // Aggregate across every registered runtime (ADR-0310) — a workspace
          // may hold Codex or OpenCode sessions, not just the default runtime's.
          const { sessions } = await aggregateSessionList({
            runtimes: runtimeRegistry.listRuntimes(),
            projectDir: workspacePath,
          });
          return sessions.map((s) => ({
            sessionId: s.id,
            cwd: s.cwd ?? workspacePath,
            title: s.title,
          }));
        } catch {
          return [];
        }
      },
    });
    refs.managedWorkspaces = workspaceStore;
    setWorkspaceManager(workspaceService);
    // A new workspace's card is raised through the marketplace's confirmation
    // provider, composed later in boot (DOR-2335).
    setWorkspaceApprovals(() => refs.templateConfirmationProvider);
    // A clone staged by a server that stopped before deciding about it is
    // never adopted: it goes before anything else can stage (DOR-2335).
    const staleClones = await workspaceService.sweepStaging();
    if (staleClones > 0)
      logger.info(`[Workspace] cleared ${staleClones} unfinished staged clone(s)`);
    workspaceReconcilerLifecycle.start(workspaceReconciler);
    logger.info('[Workspace] WorkspaceManager registered');
  }
  const upToRooms = { ...upToRuntimes, ...(await wireRooms(refs, upToRuntimes)) };
  const upToMesh = { ...upToRooms, ...(await startSearchRelayAndMesh(refs, upToRooms)) };
  const upToRelayAdapters = {
    ...upToMesh,
    ...(await wireTeamRoomAndRelayAdapters(refs, upToMesh)),
  };
  const upToApprovals = {
    ...upToRelayAdapters,
    ...(await wireConnectorEventsAndApprovals(refs, upToRelayAdapters)),
  };
  const upToConnectorServices = {
    ...upToApprovals,
    ...(await wireConnectorServices(refs, upToApprovals)),
  };
  const upToDocDelivery = {
    ...upToConnectorServices,
    ...wireDocDelivery(refs, upToConnectorServices),
  };
  const upToTasks = { ...upToDocDelivery, ...(await wireMcpTasksAndSkills(refs, upToDocDelivery)) };
  const upToCoreRoutes = { ...upToTasks, ...mountCoreRoutes(refs, upToTasks) };
  await mountLateRoutes(refs, upToCoreRoutes);
  await composeCapabilities(refs, upToCoreRoutes);
  await upToCoreRoutes.seedPersonSet();
  // Existing chats rise to their agent's level, once, after the floor it reads (DOR-3107).
  await raiseExistingChatsOnBoot(refs, {
    db,
    dorkHome,
    personSet: upToCoreRoutes.personSetPermissions,
    activity: upToCoreRoutes.activityService,
  });
  // The accounts the upgrade kept out of automatic moves, one history line (Re-seat P0).
  await recordKeptFromAutoMovesOnBoot(refs, { dorkHome, activity: upToCoreRoutes.activityService });
  const { deps, activityService, telemetryConfig, telemetryEnv, tier1SendGate, telemetryDebug } =
    upToCoreRoutes;

  const host = env.DORKOS_HOST;

  // Exposure guard (task 1.3): refuse to bind a non-loopback (publicly
  // reachable) interface unless login is enabled AND an owner account exists.
  // A hard gate — binding beyond localhost without credentials would expose the
  // instance. Container images that own their network boundary opt out with
  // DORKOS_ALLOW_INSECURE_BIND=true (see the Dockerfile integration/runtime targets).
  const bindCheck = checkBindAllowed({
    host,
    exposureAllowed: canExpose(),
    allowInsecureBind: env.DORKOS_ALLOW_INSECURE_BIND,
    hub: currentServerRole() === 'hub',
  });
  if (!bindCheck.allowed) {
    logger.error(`[Auth] ${bindCheck.reason}`);
    // Also to stderr: an operator starting from a terminal must see this even
    // when the logger only writes to the log file.
    console.error(`\n${bindCheck.reason}\n`);
    process.exit(1);
  }
  if (bindCheck.warning) {
    logger.warn(`[Auth] ${bindCheck.warning}`);
  }

  const frontDoor = composeFrontDoor(mainRequestAdmission, deps);
  const server = startMainListener({
    admission: mainRequestAdmission,
    // Every request enters the one Hono app (`http/hono-api.ts`) through the
    // front door (`http/front-door.ts`, ADR 261009-192542). Managed remote
    // access serves the same door, so its requests meet the same routes and gates.
    listen: () => createFrontDoorServer(frontDoor).listen(PORT, host),
    onListening: (server) => {
      logger.info(`[DorkOS] server running on http://${host}:${PORT}`);

      // One upgrade listener for the whole server (ADR 260805-041016): the three
      // durable event streams plus the embedded terminal's byte channel. A second
      // `server.on('upgrade')` listener beside this one would not work — every
      // listener sees every upgrade, and any that does not recognize a path
      // destroys the socket out from under the one that does.
      // A hub's computer relay endpoint refuses everything on a person's own computer.
      const upgradeRoutes = [
        ...durableStreamRoutes,
        terminalUpgradeRoute(refs.terminalManager!),
        hubRelayComputerRoute(),
      ];
      attachUpgradeRouter(server, upgradeRoutes, mainRequestAdmission);
      logger.info('[DorkOS] WebSocket upgrade router attached');
      // Wi-Fi access (DOR-2930): a second listener on the network, opened and
      // closed live by its switch, into the same front door and upgrade router.
      void lanAccess.attach({
        port: PORT,
        createServer: () => createFrontDoorServer(frontDoor, { ingress: 'wifi' }),
        attachUpgrades: (lan) => attachUpgradeRouter(lan, upgradeRoutes, mainRequestAdmission),
      });

      // DorkOS's own https listener: test homes only, for now (DOR-3172).
      tlsServer = startTlsListener(
        env,
        resolveDorkHome(),
        (tls) => createFrontDoorServer(frontDoor, { tls }),
        (opened) => attachUpgradeRouter(opened, upgradeRoutes, mainRequestAdmission),
        logger
      );

      // The two ngrok ingresses, each a loopback listener of its own: managed
      // access (edge-proof and host checks first) and the person's own tunnel.
      // Each marks what it admits, then hands requests to the same front door
      // and upgrades to the router above. Nothing listens until a tunnel opens.
      tunnelManager.attachIngresses(tunnelIngressesFor(frontDoorListener(frontDoor), server, PORT));
      // Reconnect Cloud's command stream when the boot rule allows it (DOR-2086); opens nothing.
      managedRemoteCommands.boot(db, currentRemoteBootPlan(env));

      // Fire-and-forget: record startup in the activity feed so the dashboard
      // shows when the server was last (re)started.
      activityService.emit({
        actorType: 'system',
        actorLabel: 'System',
        category: 'system',
        eventType: 'system.started',
        summary: 'DorkOS started',
      });

      // Register the anonymous daily heartbeat (Tier 1 opt-out; ADR 260713-143958).
      // `config.telemetry.heartbeat` defaults OFF, and the send folds in the env
      // kill switch AND the `tier1SendGate` captured at boot (BEFORE the first-run
      // notice wrote `lastPromptedVersion`), so a first-notice boot sends nothing.
      // Payload documented at https://dorkos.ai/telemetry (DOR-293).
      const runtimesConfig = configManager.get('runtimes');
      const runtimesConfigured = [
        'claude-code',
        ...(runtimesConfig.codex.enabled ? ['codex'] : []),
        ...(runtimesConfig.opencode.enabled ? ['opencode'] : []),
      ];
      registerHeartbeat({
        consent:
          resolveTelemetryConsent(telemetryConfig?.heartbeat ?? false, telemetryEnv) &&
          tier1SendGate,
        debug: telemetryDebug,
        dorkHome,
        dorkosVersion: SERVER_VERSION,
        runtimesConfigured,
        tunnelEnabled: configManager.get('tunnel')?.enabled ?? false,
        cloudLinked: configManager.get('cloud')?.instanceToken != null,
        collectCounts: (): HeartbeatCounts => {
          // Best-effort snapshot; any failure just contributes a zero.
          let agentCount = 0;
          try {
            agentCount = db.select().from(agents).all().length;
          } catch {
            /* ignore */
          }
          return {
            agents: agentCount,
            tasks: refs.taskStore?.getTasks().length ?? 0,
            relayAdapters: refs.adapterManager?.listAdapters().length ?? 0,
          };
        },
      });
    },
  });
  if (!server) return;

  // Surface port conflicts with an actionable message instead of a raw EADDRINUSE stack trace
  exitOnPortConflict(server, PORT);
  await startAfterListen(refs, upToCoreRoutes);
}

// Ordered teardown of all running services WITHOUT calling process.exit().
// Extracted so the admin router can invoke it before a restart.
let docNotificationCleanup: (() => void) | undefined;
/** DorkOS's own https listener, when its settings opened one (DOR-3172). */
let tlsServer: import('node:http').Server | null = null;

async function shutdownServices() {
  mainRequestAdmission.close();
  await workspaceReconcilerLifecycle.dispose();
  await localBrowserHost.close();
  await stopDocDelivery?.();
  stopDocDelivery = undefined;
  docNotificationCleanup?.();
  docNotificationCleanup = undefined;
  logger.info('[DorkOS] shutting down services');
  // Drain owned turns while their tool, account and room dependencies remain live.
  await refs.doeRuntime?.shutdown();
  refs.doeRuntime = null;
  refs.stopSessionContinuation?.();
  refs.stopSessionContinuation = undefined;
  if (refs.accountUsageStore) {
    refs.accountUsageStore.stop();
    await refs.accountUsageStore.flush().catch((err: unknown) => {
      logger.warn('[DorkOS] account usage flush failed at shutdown', { err: String(err) });
    });
    setAccountUsageStore(undefined);
    refs.accountUsageStore = undefined;
  }
  legacyRecordSweep.abort();
  refs.remoteCommunitySubscriptions?.stop();
  refs.remoteAgentAvailability?.stop();
  refs.remoteAgentAvailability = undefined;
  ownerNoticeSweep.stop();
  refs.remoteCommunitySubscriptions = undefined;
  setRemoteCommunitySubscriptionProbe(undefined);
  refs.remoteCommunityRuntime?.stop();
  refs.remoteCommunityRuntime = undefined;
  await testComposioFixture?.close();
  testComposioFixture = undefined;
  await refs.connectorRuntimeMcpListener?.close();
  refs.connectorRuntimeMcpListener = undefined;
  if (refs.healthCheckInterval) {
    clearInterval(refs.healthCheckInterval);
  }
  if (refs.dailySnapshotInterval) {
    clearInterval(refs.dailySnapshotInterval);
  }
  if (refs.sessionAttachmentSweepInterval) {
    clearInterval(refs.sessionAttachmentSweepInterval);
  }
  refs.managedAuthorityRecoveryInterval?.stop();
  refs.managedUsageMirrorRecoveryInterval?.stop();
  if (refs.stopApprovalExpirySweep) {
    refs.stopApprovalExpirySweep();
    refs.stopApprovalExpirySweep = undefined;
  }
  refs.stopConnectorFreshness?.();
  refs.stopConnectorFreshness = undefined;
  getAgentSendService()?.stop();
  // Kill any live PTYs so shutdown never leaves an orphaned shell.
  refs.terminalManager?.destroyAll();
  // A hub's linked computers redial on their next viewer.
  closeAllComputerConnections();
  // Give back every port an open dev-server preview is holding.
  await previewListeners.close();
  // Cancel any pending managed-MCP OAuth token refresh timers.
  refs.agentMcpOAuthService?.shutdown();
  // Flush any buffered usage events so a clean exit doesn't drop the tail of the
  // queue. No-op when the usage reporter never registered (consent off).
  await shutdownUsageReporter();
  // Same for the opt-in AI-metadata bridge. No-op when it never registered.
  await shutdownAiMetadataReporter();
  // Close the global session-list subscription (and its directory watcher).
  await sessionListBroadcaster.stop();
  if (refs.schedulerService) {
    await refs.schedulerService.stop();
  }
  // Stop adapters before RelayCore — adapters may need to drain in-flight messages
  if (refs.adapterManager) {
    await refs.adapterManager.shutdown();
  }
  if (refs.relayCore) {
    await refs.relayCore.close();
  }
  // Close trace store after RelayCore — ensures final spans are flushed
  refs.traceStore?.close();
  if (refs.taskFileWatcher) {
    await refs.taskFileWatcher.stopAll();
  }
  refs.taskReconciler?.stop();
  // Both halves of the skills trigger, in the order they depend on each other:
  // stop listening for turn boundaries first, so nothing can schedule work into
  // a watcher that is closing its handles.
  refs.turnEndReprojection?.stop();
  refs.turnEndReprojection = undefined;
  if (refs.skillsWatcher) {
    await refs.skillsWatcher.stop();
    refs.skillsWatcher = undefined;
  }
  // Every dev link's watch closes here, so shutdown leaves no handle open.
  if (refs.devLinkWatcher) {
    await refs.devLinkWatcher.stop();
    refs.devLinkWatcher = undefined;
  }
  refs.searchIndexer?.stop();
  refs.commitmentWiring?.stop();
  heartbeats.stopHeartbeats();
  if (refs.meshCore) {
    refs.meshCore.stopPeriodicReconciliation();
    refs.meshCore.close();
  }
  await shutdownRuntimes(refs.creditsRelay);
  refs.creditsRelay = null;
  // Stream cancelled, managed access drained within its deadline, what is owed kept (DOR-2086).
  await managedRemoteCommands.shutdown();
  await tunnelManager.stop();
  await lanAccess.close();
  tlsServer?.close();
  tlsServer = null;
  // After every runtime and the scheduler: nothing is left to hold awake.
  await keepAwakeService.stop();
  getCloudLinkManager().stop();
  stopCreditsLifecycle();
  // Flush and tear down debug tracing last so late spans are written. No-op
  // when tracing is off.
  await shutdownObservability();
  // Retain the existing final lock release for admin restart's successor handoff.
  // Workspace disposal alone does not prove that every server writer is quiescent.
  refs.releaseInstanceLock?.();
  refs.releaseInstanceLock = undefined;
}

// Graceful shutdown on the first signal; a second one exits at once.
const shutdown = createSignalShutdown(shutdownServices);

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Safety nets — log and exit gracefully on truly unhandled errors instead of
// silently crashing. These should never fire if route-level error handling is
// correct, but they prevent data loss if something slips through.
process.on('uncaughtException', (err) => {
  // The Error goes over whole, deliberately. Flattening it here — the
  // `{ message, stack, name }` this used to build — put it out of reach of the
  // clipping both reporters do, because both recognise an error by its type: a
  // crash carrying a subprocess dump wrote a 1,200,561-byte NDJSON line where
  // this shape writes 8,820 (DOR-1827). The serializer writes the same three
  // fields — the message as `error`, which is what every other error line in
  // the file calls it — plus `cause` and any `errno`/`code` the error carries.
  logger.error('[DorkOS] Uncaught exception — shutting down', err);
  // Fatal path: bounded-await the crash report so it actually reaches the
  // network before we exit (a bare fire-and-forget would be dropped when the
  // event loop stops on the next line). The timeout guards against a hung
  // endpoint delaying shutdown.
  void flushServerError(err).finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  // Nested, but still whole — see the uncaughtException handler above. The
  // serializer walks into `reason` and writes `name`, `message` and `stack`
  // there, bounded; hand-flattening it wrote 1,200,550 bytes where this
  // writes 8,826 (DOR-1827). A non-Error reason is passed through as it was.
  logger.error('[DorkOS] Unhandled promise rejection', { reason });
  // Non-fatal (we don't exit), so fire-and-forget is fine here.
  void captureServerError(reason);
});

start().catch(async (err) => {
  mainRequestAdmission.close();
  try {
    await workspaceReconcilerLifecycle.dispose();
  } catch (cleanupError) {
    logger.error(
      '[workspace] Reconciliation disposal failed during startup cleanup:',
      cleanupError
    );
  }
  // A later startup failure must not leave the owned offline listener running.
  await testComposioFixture?.close();
  testComposioFixture = undefined;
  await localBrowserHost.close();
  await stopDocDelivery?.();
  stopDocDelivery = undefined;
  docNotificationCleanup?.();
  docNotificationCleanup = undefined;
  // Two startup failures are addressed to the operator rather than to whoever
  // maintains DorkOS: a database that will not open, and a backup that could not
  // be written. Both carry instructions in their message and both are resolved
  // by doing something to the filesystem, so they print as that message and
  // nothing else — a stack trace above it only buries the sentence that matters.
  if (err instanceof DatabaseOpenError || err instanceof SnapshotFailedError) {
    logger.error(`[DorkOS] Cannot start.\n\n${err.message}\n`);
    process.exit(1);
  }

  const info = logError(err);
  logger.error('[DorkOS] Fatal error during startup', info);

  process.exit(1);
});
