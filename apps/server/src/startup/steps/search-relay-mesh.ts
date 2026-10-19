/**
 * Message search, the Tasks and Relay switches, RelayCore, and Mesh with its
 * startup reconciliation and the work that waits on it.
 *
 * Moved out of `index.ts` unchanged; it runs at the same point in `start()`.
 *
 * @module startup/steps/search-relay-mesh
 */
import { selectSearchSources, SearchIndexer } from '../../services/search/index.js';
import { env } from '../../env.js';
import { logger, logError } from '../../lib/logger.js';
import { configManager } from '../../services/core/config-manager.js';
import { resolveTasksFiring } from '../../services/tasks/resolve-firing.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import { setTasksInitError } from '../../services/tasks/task-state.js';
import { relayStartsEnabled, setRelayInitError } from '../../services/relay/relay-state.js';
import path from 'path';
import { AdapterRegistry, RelayCore, SignalEmitter } from '@dorkos/relay';
import { TraceStore } from '../../services/relay/trace-store.js';
import { traceRelay } from '../../services/observability/index.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { notify } from '../../services/notifications/notification-service.js';
import { deadLetterPayload } from '../../services/notifications/emitters/dead-letter.js';
import { MeshCore } from '@dorkos/mesh';
import { registerConnectorAgentCleanup } from '../../services/connectors/agent-access-cleanup.js';
import {
  createAgentIdentityUnregisterCascade,
  getAgentIdentityService,
} from '../../services/core/agent-identity/index.js';
import { registerRemoteCommunityUnregisterCascade } from '../../services/communities/remote/mesh-unregister-cascade.js';
import { registerRoomUnregisterCascade } from '../../services/rooms/manage/departed-agents.js';
import { setAgentPathLookup } from '../../services/mesh/agent-path-lookup.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { ensureDorkBot } from '../../services/mesh/ensure-dorkbot.js';
import {
  migrateRoomTranscripts,
  frozenRoomWorktrees,
} from '../../services/runtimes/claude-code/migrate-room-transcripts.js';
import { resolveClaudeRootSet } from '../../services/runtimes/claude-code/claude-config-dir.js';
import {
  runPermissionUpgradeSweep,
  permissionAgentRefs,
  readRawManifestFile,
  runPermissionRetirements,
  recordEndedStandingGrants,
} from '../../services/core/permissions/index.js';
import { SERVER_VERSION } from '../../lib/version.js';
import { titleForMcpTool } from '../../services/core/mcp-tool-tiers.js';
import {
  loadOfficialSpace,
  getRemoteConnectionStore,
} from '../../services/communities/remote/state.js';
import { ownerNoticeSweep } from '../../services/notifications/emitters/community-owner-notice-sweep.js';
import {
  sweepOrphanedMirrors,
  orphanedMirrorSweepDeps,
} from '../../services/communities/remote/orphaned-mirror-sweep.js';
import { flushRestoredAgents } from '../../services/marketplace/restored-agents.js';
import {
  projectsOfAgents,
  recoverInterruptedInstalls,
  projectSweepDirs,
} from '../../services/marketplace/recovery/backup-janitor.js';
import { scanInstallationsAcrossScopes } from '../../services/marketplace/installed-scanner.js';
import { migrateSavedCopies } from '../../services/marketplace/lib/saved-copies/migrate-saved-copies.js';
import { withInstallTargetLock } from '../../services/marketplace/transaction.js';
import { backfillAgentWorkspaceSkills } from '../../services/harness/project-agent-workspace.js';
import { refreshUntouchedTemplates } from '../../services/mesh/refresh-untouched-templates.js';
import { agentLivenessObserver } from '../../services/notifications/emitters/agent-liveness.js';
import { setMeshInitError } from '../../services/mesh/mesh-state.js';
import type { OpenConfigAndDatabaseResult } from './config-and-database.js';
import type { ClaimDataDirectoryResult } from './data-directory.js';
import type { WireCoreStoresResult } from './core-stores.js';
import type { WireRoomsResult } from './rooms.js';
import type { WireSessionServicesResult } from './session-services.js';
import type { ServerRefs } from '../server-refs.js';
import type { installSweepLogger } from '../../services/marketplace/recovery/install-sweep-log.js';

/** What {@link startSearchRelayAndMesh} reads from the startup steps before it. */
export interface StartSearchRelayAndMeshInput {
  db: OpenConfigAndDatabaseResult['db'];
  dorkHome: ClaimDataDirectoryResult['dorkHome'];
  connectorRegistry: WireCoreStoresResult['connectorRegistry'];
  connectorAuthorityCleanup: WireCoreStoresResult['connectorAuthorityCleanup'];
  roomAuthors: WireRoomsResult['roomAuthors'];
  roomService: WireRoomsResult['roomService'];
  permissionObserver: WireSessionServicesResult['permissionObserver'];
  activityService: WireCoreStoresResult['activityService'];
  logInstallSweep: ReturnType<typeof installSweepLogger>;
}

/**
 * Start message search, Relay and Mesh.
 *
 * @param refs - The server's live references, which shutdown reads.
 * @param built - What the steps before this one built.
 */
export async function startSearchRelayAndMesh(
  refs: ServerRefs,
  built: StartSearchRelayAndMeshInput
) {
  const {
    db,
    dorkHome,
    connectorRegistry,
    connectorAuthorityCleanup,
    roomAuthors,
    roomService,
    permissionObserver,
    activityService,
    logInstallSweep,
  } = built;
  // Message search (ADR 260728-214214) — a derived index over what was said,
  // rebuilt from the sources it reads and owning nothing. Unconditional and
  // cheap: the sweep is one GROUP BY per source plus a read of whatever is new,
  // and an install with nothing in it does no work at all. Nothing a person can
  // reach queries these rows yet.
  //
  // The ONE place `DORKOS_SEARCH_NO_EXTERNAL_HISTORY` is read (DOR-1551). A
  // throwaway `DORK_HOME` isolates what DorkOS owns; it does not move
  // `~/.claude`, `$CODEX_HOME` or OpenCode's store, so a harness that must read
  // nobody's history says so and gets the `corpus: 'dorkos'` sources only. Unset
  // on every real install, where the full set is the documented coverage.
  const searchSources = selectSearchSources({
    excludeExternalHistory: env.DORKOS_SEARCH_NO_EXTERNAL_HISTORY,
  });
  if (env.DORKOS_SEARCH_NO_EXTERNAL_HISTORY) {
    logger.info('[Search] indexing this data directory only; no external history will be read', {
      sources: searchSources.map((source) => source.id),
    });
  }
  refs.searchIndexer = new SearchIndexer(db, searchSources);
  refs.searchIndexer.start();

  // Initialize Tasks scheduler if enabled
  const schedulerConfig = configManager.get('scheduler');

  const tasksEnabled =
    // eslint-disable-next-line no-restricted-syntax -- Checking presence, not value: env.ts can't distinguish "unset" from "set to false"
    'DORKOS_TASKS_ENABLED' in process.env ? env.DORKOS_TASKS_ENABLED : schedulerConfig.enabled;

  // The FIRING gate (ADR-285) is decoupled from the subsystem gate above: tasks
  // still list/display wherever the subsystem is up, but only a real production
  // environment fires (dev/preview default off unless DORKOS_TASKS_ENABLED=true).
  const firing = resolveTasksFiring({
    nodeEnv: env.NODE_ENV,
    // eslint-disable-next-line no-restricted-syntax -- presence check: unset vs explicit false
    explicitOverride: 'DORKOS_TASKS_ENABLED' in process.env ? env.DORKOS_TASKS_ENABLED : undefined,
    schedulerEnabled: schedulerConfig.enabled,
  });

  if (tasksEnabled) {
    try {
      refs.taskStore = new TaskStore(db);
      logger.info('[Tasks] TaskStore initialized');
    } catch (err) {
      const errInfo = logError(err);
      logger.error(`[Tasks] Failed to initialize TaskStore at ${dorkHome}`, errInfo);
      setTasksInitError(errInfo.error);
      // Tasks failure is non-fatal: server continues without scheduler routes.
    }
  }

  // Initialize Relay if enabled
  const relayConfig = configManager.get('relay');
  // DORKOS_RELAY_ENABLED wins only when set; unset, the saved setting decides.
  const relayEnabled = relayStartsEnabled(env.DORKOS_RELAY_ENABLED, relayConfig.enabled);

  // Phase A: core relay infrastructure (RelayCore + TraceStore)
  // AdapterManager construction is deferred to Phase C (after meshCore init)
  // so that meshCore is available for CWD resolution via buildContext().
  const relayDataDir = relayConfig.dataDir ?? path.join(dorkHome, 'relay');
  if (relayEnabled) {
    try {
      refs.adapterRegistry = new AdapterRegistry();
      refs.adapterRegistry.setLogger(logger);

      // Initialize trace store before RelayCore so it can be injected for delivery tracking
      refs.traceStore = new TraceStore(db);
      logger.info('[Relay] TraceStore initialized');

      // traceRelay wraps publish with a relay.dispatch span when debug tracing
      // is on; returns the core untouched otherwise (zero overhead).
      refs.relayCore = traceRelay(
        new RelayCore({
          dataDir: relayDataDir,
          adapterRegistry: refs.adapterRegistry,
          db,
          traceStore: refs.traceStore,
          logger,
          // The hourly ceiling on turns agent messaging may start (DOR-791),
          // enforced at the adapter dispatch every surface funnels through.
          // Read from config PER DISPATCH, not captured here, so a change in
          // Settings takes effect at once rather than at the next restart —
          // the same contract the room ceilings have.
          turnCeiling: {
            perAgent: () => configManager.get('relay').maxAgentTurnsPerAgentPerHour,
            global: () => configManager.get('relay').maxAgentTurnsTotalPerHour,
          },
          // Tick the Pulse attention badge the instant a message is dead-lettered
          // (DOR-403) instead of waiting for the 30s dead-letters poll, and
          // leave a quiet row in the inbox so it is still findable tomorrow.
          onDeadLetter: (notice) => {
            eventFanOut.broadcast('relay_dead_letter', notice);
            void notify('dead-letter.created', deadLetterPayload(notice));
          },
        })
      );
      await refs.relayCore.registerEndpoint('relay.system.console');
      logger.info(`[Relay] RelayCore initialized (dataDir: ${relayDataDir})`);
    } catch (err) {
      const errInfo = logError(err);
      logger.error(`[Relay] Failed to initialize at ${relayDataDir}`, errInfo);
      setRelayInitError(errInfo.error);
      // Relay failure is non-fatal: server continues without relay routes.
      refs.relayCore = undefined;
      refs.traceStore = undefined;
    }
  }

  // Initialize Mesh (always-on, ADR-0062)
  // Wire SignalEmitter when Relay is enabled so MeshCore can broadcast lifecycle
  // signals. When Relay is absent, signalEmitter stays undefined and MeshCore
  // silently skips signal emission.
  const meshSignalEmitter = refs.relayCore ? new SignalEmitter() : undefined;

  try {
    refs.meshCore = new MeshCore({
      db,
      relayCore: refs.relayCore,
      signalEmitter: meshSignalEmitter,
      // ADR-0043: the reconciler rebuilds the DB from files by walking the
      // managed agents home dir (DorkBot + installed agents) every pass.
      agentsHomeDir: path.join(dorkHome, 'agents'),
      // A room's files are never an agent's home (spec `agent-home-desk` §3.3).
      roomFilesDir: path.join(dorkHome, 'rooms'),
      logger,
    });
    logger.info('[Mesh] MeshCore initialized');

    // This must precede startup reconciliation: that pass can permanently
    // remove an expired unreachable agent and every removal path must revoke
    // its canonical connector authority in the same callback cascade.
    registerConnectorAgentCleanup({
      mesh: refs.meshCore,
      registry: connectorRegistry,
      authorityCleanup: connectorAuthorityCleanup,
      logger,
    });

    // Cascade: deleting or unregistering an agent is an operator's decision to
    // turn it off (DOR-490), and until this fired that decision had no effect
    // on identity — `AgentIdentityService.revoke` had zero production callers,
    // so an agent token kept working past the operator's own removal, bounded
    // only by its idle/absolute expiry clocks. Fires for both DELETE
    // `/api/mesh/agents/:id` and `/api/mesh/agents/:id/data` (both route
    // through `meshCore.unregister`) and the reconciler's grace-period sweep —
    // every path that removes an agent shares this one cascade. The callback's
    // `projectPath` is `AgentIdentityService`'s `agentPath` — the same value
    // `agent-token-env.ts` mints tokens under — captured before registry
    // removal, exactly like the sibling cascades below.
    refs.meshCore.onUnregister(
      createAgentIdentityUnregisterCascade(getAgentIdentityService, logger)
    );

    // A removed Mesh manifest no longer owns any remote enrollment. The
    // cascade stops and aborts held delivery before the next network boundary,
    // then closes only that manifest's native streams.
    if (refs.remoteCommunitySubscriptions) {
      registerRemoteCommunityUnregisterCascade(
        refs.meshCore,
        roomAuthors,
        refs.remoteCommunitySubscriptions
      );
    }

    // An unregistered agent leaves every channel roster in the same moment
    // (DOR-2095); its direct messages keep it, drawn as retired, and its
    // messages keep their author. Its seats are kept aside and given back if
    // the same agent is registered again. Registered before startup
    // reconciliation, because the reconciler's orphan sweep unregisters
    // through this same signal and must not leave a seat behind either.
    registerRoomUnregisterCascade(refs.meshCore, roomService, logger);

    // Wire the cwd -> agent lookup notification emitters read from (session
    // lifecycle, ask resolution): both fire from module-level projector
    // subscriptions registered before this line runs, so they read this
    // singleton lazily rather than receiving MeshCore as a constructor
    // dependency. See `agent-path-lookup.ts`.
    setAgentPathLookup(refs.meshCore);

    // Provide MeshCore to every registered runtime that can use it: per-session
    // manifest lookup, peer-agents context, and the guard that decides whether a
    // turn's working directory hosts a registered agent worth minting an identity
    // token for. `setMeshCore` is an optional DI setter on `AgentRuntime`, so a
    // runtime that has no use for it (test-mode, opencode) simply has none.
    for (const runtime of runtimeRegistry.listRuntimes()) {
      runtime.setMeshCore?.(refs.meshCore);
    }

    // Run startup reconciliation (non-fatal)
    try {
      const result = await refs.meshCore.reconcileOnStartup();
      logger.info('[Mesh] Startup reconciliation complete', result);
      refs.meshStartupReconciled = true;
    } catch (err) {
      logger.error('[Mesh] Startup reconciliation failed', logError(err));
    }

    // Ensure DorkBot system agent exists (non-fatal)
    try {
      await ensureDorkBot(refs.meshCore, dorkHome);
    } catch (err) {
      logger.warn('[Mesh] Failed to ensure DorkBot system agent', logError(err));
    }

    // Move room transcripts filed under worktree folders to their agents' homes
    // (spec `agent-home-desk` §8.1): room turns stand at home now, so that is
    // where Claude Code resumes them and where DorkOS reads them. HERE because
    // it needs the loaded registry (it decides whose a worktree is, and an
    // empty list would write the marker having moved nothing) and must finish
    // before any room turn can launch — rooms start answering once relay and
    // HTTP are up, below. It can throw; a throw leaves the marker unwritten, so
    // the next start tries again, and must never stop this one.
    try {
      await migrateRoomTranscripts({
        dorkHome,
        claudeRoots: resolveClaudeRootSet(),
        agentPaths: refs.meshCore.listWithPaths().map((agent) => agent.projectPath),
      });
    } catch (err) {
      logger.warn('[rooms] could not move room transcripts to agent homes yet', logError(err));
    }

    // The permission upgrade (spec `agent-permissions` D13), after the mesh and
    // Activity are up: on every boot, fold whatever retired permission setting is
    // still on disk (a manifest's `enabledToolGroups`/`tierCeiling`, the config's
    // `agentContext`) and record what that decided; once per server version,
    // record what the config migration changed. Non-fatal: a failure costs the
    // audit line, never the boot, and a manifest is still folded on every read.
    try {
      const mesh = refs.meshCore;
      const upgradeDeps: Parameters<typeof runPermissionUpgradeSweep>[0] = {
        version: SERVER_VERSION,
        config: {
          get: () => configManager.get('permissions'),
          // Merged onto the stored section, so a field the sweep does not know
          // (`trustedStoresAppliedAt`) is never dropped by its write.
          set: (next) =>
            configManager.set('permissions', { ...configManager.get('permissions'), ...next }),
        },
        agents: () => permissionAgentRefs(mesh),
        readRawManifest: readRawManifestFile,
        writeFolded: async (agentId, fields) => {
          const write = async () => {
            await mesh.update(agentId, fields);
          };
          const agentPath = mesh.listWithPaths().find((a) => a.id === agentId)?.projectPath;
          // The sweep's own write is not an outside change.
          if (agentPath) await permissionObserver.writing(agentPath, fields.permissions, write);
          else await write();
          // Never moves the person-set floor (DOR-3107): the fold reads fields
          // an agent can write into its own file, so a loosening it carries is
          // the agent's word, not a person's. A tightening still applies.
        },
        retireAgentContext: () => configManager.retireAgentContext(),
        activity: activityService,
        logger,
      };
      await runPermissionRetirements(upgradeDeps);
      await runPermissionUpgradeSweep(upgradeDeps);
    } catch (err) {
      logger.warn('[Permissions] Upgrade sweep failed', logError(err));
    }
    // Standing permissions this upgrade ended, one history line each. Runs
    // whenever the capture file exists, not once per version: the file is the
    // record that the lines are still owed.
    try {
      const mesh = refs.meshCore;
      await recordEndedStandingGrants({
        dorkHome,
        agents: () => permissionAgentRefs(mesh),
        actionTitle: (id) => refs.capabilityRegistry?.get(id)?.title ?? titleForMcpTool(id) ?? id,
        activity: activityService,
        logger,
      });
    } catch (err) {
      logger.warn('[Permissions] Could not record the ended standing permissions', logError(err));
    }
    // Which space is official (spec `official-community-space` D5), before any
    // remote work and before the server listens: until it has loaded no space
    // is, so with spaces off nothing remote is reachable (fail closed). Loaded
    // whatever Mesh did, since the official space's routes do not need Mesh.
    await loadOfficialSpace();
    if (refs.meshStartupReconciled) {
      refs.remoteCommunityRuntime?.start();
      refs.remoteCommunitySubscriptions?.start();
      refs.remoteAgentAvailability?.start();
      ownerNoticeSweep.start();
      // Copies left behind by a connection that no longer exists (DOR-2334).
      const subscriptions = refs.remoteCommunitySubscriptions;
      if (refs.remoteCommunityRuntime && subscriptions)
        void sweepOrphanedMirrors(
          orphanedMirrorSweepDeps(
            getRemoteConnectionStore(),
            refs.remoteCommunityRuntime.mirrors,
            (communityRef, ownerAuthorId) =>
              subscriptions.revokeConnection(communityRef, ownerAuthorId)
          )
        );
    }

    // Settle marketplace installs a crash interrupted inside registered
    // projects (`<projectPath>/.dork/` and `.agents/skills/`, including the
    // project an installed agent lives in), which only the registry can list —
    // the global ones were settled before the app started (DOR-2273). This
    // writes into a person's repository only to finish undoing a change DorkOS
    // itself was making there, and only to entries whose names prove they are
    // DorkOS's own records. Fire-and-forget: each target is settled under its
    // install lock, so an install that races it simply waits.
    flushRestoredAgents(refs.meshCore);
    try {
      const projects = projectsOfAgents(refs.meshCore.listWithPaths().map((a) => a.projectPath));
      refs.sweptProjects = projects;
      refs.projectInstallRecovery = recoverInterruptedInstalls(
        projects.flatMap(projectSweepDirs),
        logger
      )
        .then((summary) => logInstallSweep('project installs', summary))
        .catch((err: unknown) => {
          logger.warn('[Marketplace] Project install recovery failed', logError(err));
        })
        // Once installs are settled: copies an earlier version saved aside in
        // a project install stop running and loading (DOR-2340). Global
        // installs were done at boot; a done root is skipped by its marker.
        // Before the legacy-record sweep below, which chains on this promise.
        .then(async () => {
          const scopes = (refs.meshCore?.listWithPaths() ?? []).map((a) => ({
            projectPath: a.projectPath,
            id: a.id,
            name: a.displayName ?? a.name,
          }));
          const installs = await scanInstallationsAcrossScopes(dorkHome, scopes);
          await migrateSavedCopies(
            installs.map((i) => i.installPath),
            withInstallTargetLock,
            logger
          );
        })
        .catch((err: unknown) => {
          logger.warn('[Marketplace] Could not check saved copies', logError(err));
        });
    } catch (err) {
      logger.warn('[Marketplace] Project install recovery failed', logError(err));
    }

    // Bring every agent workspace DorkOS owns up to the current Operating DorkOS
    // skill pack, and link it where Claude Code reads it. Two repairs in one
    // pass: agents seeded once at creation never saw a later pack version, so
    // they are still being taught corrections that were retracted versions ago
    // (DOR-671), and agents seeded before the projection existed had their
    // skills on disk but invisible to their runtime (DOR-659). Seeding runs
    // before the projection, which is what makes a skill usable on THIS boot
    // rather than the next one.
    //
    // Runs on every boot, not once: both halves are idempotent and self-healing,
    // so re-running is how a workspace that lost its links or fell behind the
    // pack catches up. Runs after startup reconciliation has populated the
    // registry from disk, so it sees every agent; `dorkHome` scopes it to the
    // homes DorkOS owns, because a registered agent can point at a person's own
    // repository and a boot is not permission to write into one.
    // Fire-and-forget: it yields between workspaces and never throws, so it
    // repairs in the background instead of delaying boot.
    try {
      const workspaces = refs.meshCore.listWithPaths().map((agent) => agent.projectPath);
      backfillAgentWorkspaceSkills(workspaces, dorkHome).catch((err: unknown) => {
        logger.warn('[Mesh] Agent workspace skill backfill failed', logError(err));
      });
      // Same agent homes, same fire-and-forget shape: starter text nobody
      // edited catches up with today's template (DOR-2779, ADR-0302 amendment).
      refreshUntouchedTemplates(workspaces, dorkHome).catch((err: unknown) => {
        logger.warn('[Mesh] Starter text refresh failed', logError(err));
      });
    } catch (err) {
      logger.warn('[Mesh] Failed to start agent workspace skill backfill', logError(err));
    }

    // Tick the Pulse attention badge on a real liveness transition (an agent
    // went offline or came back online) instead of waiting for the client's
    // mesh-status poll (DOR-403).
    refs.meshCore.onLivenessChange((result) =>
      eventFanOut.broadcast('mesh_liveness_changed', {
        unreachable: result.unreachable,
        resurrected: result.resurrected,
        changedAt: new Date().toISOString(),
      })
    );

    // Say WHICH agent went quiet, once each, in the inbox. A second subscriber
    // rather than a line inside the one above: the badge wants counts and this
    // wants identities, and the observer list is what makes both possible
    // without either owning the other.
    refs.meshCore.onLivenessChange(agentLivenessObserver(refs.meshCore.agentRegistry));

    // Start periodic reconciliation (every 5 minutes)
    refs.meshCore.startPeriodicReconciliation(300_000);
  } catch (err) {
    const errInfo = logError(err);
    logger.error('[Mesh] Failed to initialize MeshCore', errInfo);
    setMeshInitError(errInfo.error);
    // Mesh failure is non-fatal: server continues without mesh routes.
  }

  // The room worktree folders room turns stood in before they moved home, read
  // once and never grown — see `setAgentSessionSources` above.
  refs.frozenWorktrees = await frozenRoomWorktrees(dorkHome).catch(() => []);
  return { schedulerConfig, tasksEnabled, firing, relayEnabled, meshSignalEmitter };
}

/** What {@link startSearchRelayAndMesh} hands the steps after it. */
export type StartSearchRelayAndMeshResult = Awaited<ReturnType<typeof startSearchRelayAndMesh>>;
