/**
 * Route dependencies for connectors, relay and sessions, heartbeats, the
 * session list broadcaster, deep health, the agent-created seam and the
 * permission service.
 *
 * Moved out of `index.ts` unchanged; it runs at the same point in `start()`.
 *
 * @module startup/steps/core-routes
 */
import { configManager } from '../../services/core/config-manager.js';
import type { ConnectorRoutesDeps } from '../../routes/connectors.js';
import { credentialStore } from '../../services/core/credential-provider.js';
import { ConnectorSessionAccessService } from '../../services/connectors/resources/session-access-service.js';
import { setRelayEnabled } from '../../services/relay/relay-state.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import type { SessionOriginResolvers } from '../../services/session/index.js';
import { getSessionStartedByStore } from '../../services/session/origin/session-started-by-store.js';
import { getSessionTouchStore } from '../../services/session/origin/session-touch-store.js';
import * as heartbeats from '../../services/heartbeats/index.js';
import { sessionListBroadcaster } from '../../services/session/catalog/session-list-broadcaster.js';
import { wireSessionVisibility } from '../../services/audit/index.js';
import { applyTrackerItemsLive } from '../../services/session/fleet/flow-run-link.js';
import { startProjectRegistry } from '../../services/projects/project-feeds.js';
import { projectRegistry } from '../../services/projects/project-registry.js';
import { roomSessionPlace } from '../../services/rooms/repo/room-turn-place.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { logger } from '../../lib/logger.js';
import { subscribeRuntimeTurns } from '../../services/session/runtime-turns/runtime-turn.js';
import { withIntegrity } from '../../services/marketplace/lib/integrity/verify-install.js';
import { scanInstallationsAcrossScopes } from '../../services/marketplace/installed-scanner.js';
import { installedGitProtection } from '../../lib/git-safety.js';
import type { DebugDeps } from '../../routes/debug.js';
import type { ShapeScheduleServiceLike } from '../../services/shapes/apply-shape.js';
import { ShapeScheduleService } from '../../services/shapes/shape-schedule-service.js';
import { createEveryAgentArrivalReaction } from '../../services/connectors/every-agent-activity.js';
import {
  createArrivalStep,
  createPermissionService,
  seedPersonSetOnBoot,
} from '../../services/core/permissions/index.js';
import {
  setOnAgentCreated,
  type CreatedAgentInfo,
  notifyAgentCreated,
} from '../../services/core/agent-created-hook.js';
import { joinTeamRoom } from '../../services/rooms/ensure-team-room.js';
import { runAgentCreatedProjection } from '../../services/harness/project-on-agent-created.js';
import { rebindShapeSchedulesForAgent } from '../../services/shapes/rebind-schedules.js';
import { listInstalledShapeManifests } from '../../services/shapes/shape-services.js';
import type { AdoptedAgent } from '@dorkos/mesh';
import type { WireCoreStoresResult } from './core-stores.js';
import type { WireConnectorEventsAndApprovalsResult } from './connector-events-approvals.js';
import type { WireConnectorServicesResult } from './connector-services.js';
import type { OpenConfigAndDatabaseResult } from './config-and-database.js';
import type { WireDocDeliveryResult } from './doc-delivery.js';
import type { WireMcpTasksAndSkillsResult } from './mcp-tasks-skills.js';
import type { StartSearchRelayAndMeshResult } from './search-relay-mesh.js';
import type { WireRoomsResult } from './rooms.js';
import type { WireTeamRoomAndRelayAdaptersResult } from './team-room-relay-adapters.js';
import type { WireSessionServicesResult } from './session-services.js';
import type { ClaimDataDirectoryResult } from './data-directory.js';
import type { ServerRefs } from '../server-refs.js';
import { credentialGated } from '../../services/core/auth/gate-policy.js';
import {
  watchSessionRelaySwitch,
  wireSessionRelay,
} from '../../services/core/session-relay/index.js';

/** What {@link mountCoreRoutes} reads from the startup steps before it. */
export interface MountCoreRoutesInput {
  connectorOwner: WireCoreStoresResult['connectorOwner'];
  connectorBootstrapper: WireConnectorEventsAndApprovalsResult['connectorBootstrapper'];
  connectorEventSubscriptions: WireConnectorEventsAndApprovalsResult['connectorEventSubscriptions'];
  connectorEventService: WireConnectorServicesResult['connectorEventService'];
  connectorEventGrants: WireConnectorServicesResult['connectorEventGrants'];
  connectorEventSettings: WireConnectorEventsAndApprovalsResult['connectorEventSettings'];
  managedEventConsent: WireConnectorServicesResult['managedEventConsent'];
  connectorRegistry: WireCoreStoresResult['connectorRegistry'];
  connectorManagementReviews: WireConnectorServicesResult['connectorManagementReviews'];
  connectorReconciliation: WireConnectorServicesResult['connectorReconciliation'];
  connectorOperatorQueries: WireConnectorServicesResult['connectorOperatorQueries'];
  catalogLogos: WireConnectorServicesResult['catalogLogos'];
  connectorAuthenticationFlows: WireConnectorServicesResult['connectorAuthenticationFlows'];
  connectorLifecycle: WireConnectorServicesResult['connectorLifecycle'];
  connectorAppActions: WireConnectorServicesResult['connectorAppActions'];
  connectorSignIns: WireConnectorServicesResult['connectorSignIns'];
  db: OpenConfigAndDatabaseResult['db'];
  sessionConnectorAttachmentStore: WireCoreStoresResult['sessionConnectorAttachmentStore'];
  connectorHolds: WireDocDeliveryResult['connectorHolds'];
  deps: WireMcpTasksAndSkillsResult['deps'];
  mountedRouters: string[];
  relayEnabled: StartSearchRelayAndMeshResult['relayEnabled'];
  activityService: WireCoreStoresResult['activityService'];
  roomStore: WireRoomsResult['roomStore'];
  roomService: WireRoomsResult['roomService'];
  roomAuthors: WireRoomsResult['roomAuthors'];
  notifyDm: WireTeamRoomAndRelayAdaptersResult['notifyDm'];
  commitments: WireSessionServicesResult['commitments'];
  auditAccounts: WireCoreStoresResult['auditAccounts'];
  dorkHome: ClaimDataDirectoryResult['dorkHome'];
  roomWorktrees: WireRoomsResult['roomWorktrees'];
  docChannelMetrics: WireConnectorEventsAndApprovalsResult['docChannelMetrics'];
  arrivalRecord: WireSessionServicesResult['arrivalRecord'];
  personSetPermissions: WireSessionServicesResult['personSetPermissions'];
  teamRoomDeps: WireTeamRoomAndRelayAdaptersResult['teamRoomDeps'];
  momentDetectors: WireTeamRoomAndRelayAdaptersResult['momentDetectors'];
  permissionObserver: WireSessionServicesResult['permissionObserver'];
}

/**
 * Fill in the connector, relay, session and permission route dependencies.
 *
 * @param refs - The server's live references, which shutdown reads.
 * @param built - What the steps before this one built.
 */
export function mountCoreRoutes(refs: ServerRefs, built: MountCoreRoutesInput) {
  const {
    connectorOwner,
    connectorBootstrapper,
    connectorEventSubscriptions,
    connectorEventService,
    connectorEventGrants,
    connectorEventSettings,
    managedEventConsent,
    connectorRegistry,
    connectorManagementReviews,
    connectorReconciliation,
    connectorOperatorQueries,
    catalogLogos,
    connectorAuthenticationFlows,
    connectorLifecycle,
    connectorAppActions,
    connectorSignIns,
    db,
    sessionConnectorAttachmentStore,
    connectorHolds,
    deps,
    mountedRouters,
    relayEnabled,
    activityService,
    roomStore,
    roomService,
    roomAuthors,
    notifyDm,
    commitments,
    auditAccounts,
    dorkHome,
    roomWorktrees,
    docChannelMetrics,
    arrivalRecord,
    personSetPermissions,
    teamRoomDeps,
    momentDetectors,
    permissionObserver,
  } = built;
  // Every `/api/connectors` group, served from the Hono `/api` app in the
  // order `routes/connectors.ts` explains. Saving a vendor key reloads its
  // provider live (no restart). Program execution joins once the capability
  // registry is composed, further down.
  const connectorOwnerBoundary = {
    resolveOwner: () => connectorOwner,
    loginEnabled: credentialGated,
  };
  const connectorRoutes: ConnectorRoutesDeps = {
    providers: { bootstrapper: connectorBootstrapper, credentialStore },
    events: {
      store: connectorEventSubscriptions,
      subscriptions: connectorEventService,
      grants: connectorEventGrants,
      settings: connectorEventSettings,
      managed: managedEventConsent,
      ...connectorOwnerBoundary,
    },
    management: {
      registry: connectorRegistry,
      reviews: connectorManagementReviews,
      reconciliation: connectorReconciliation,
      ...connectorOwnerBoundary,
      ...(refs.connectorAgentRequests && { agentRequests: refs.connectorAgentRequests }),
    },
    resources: {
      query: connectorOperatorQueries,
      logos: catalogLogos,
      authentication: connectorAuthenticationFlows,
      lifecycle: connectorLifecycle,
      actions: connectorAppActions,
      signIns: connectorSignIns,
      sessionAccess: new ConnectorSessionAccessService({
        db,
        query: connectorOperatorQueries,
        overrides: sessionConnectorAttachmentStore,
      }),
      ...connectorOwnerBoundary,
    },
    holds: { holds: connectorHolds },
  };
  deps.connectors = connectorRoutes;
  mountedRouters.push('connectors');

  // Relay routes, only when Relay is enabled and started.
  if (relayEnabled && refs.relayCore) {
    deps.relay = {
      relayCore: refs.relayCore,
      ...(refs.adapterManager && { adapterManager: refs.adapterManager }),
      ...(refs.traceStore && { traceStore: refs.traceStore }),
      activity: activityService,
    };
    // The claim feed (connection-scoping spec §Part 3) — mounted only when
    // the store was actually wired (relay enabled + binding subsystem up).
    const unclaimedChatsStore = refs.adapterManager?.getUnclaimedChats();
    const bindingStoreForClaims = refs.adapterManager?.getBindingStore();
    if (unclaimedChatsStore && bindingStoreForClaims) {
      // The claim card's "Answer in a channel" primary action (DOR-882) needs
      // the same lifecycle coordinator DOR-878's "Bridge to a channel" route
      // uses — optional, so a claim still lands (privately) on an install
      // where bridging isn't wired.
      const lifecycleForClaims = refs.adapterManager?.getBridgeLifecycle();
      // The group-add claim flow's "Leave" action (DOR-883) — bound to this
      // one narrowed reference rather than closing over `adapterManager`
      // itself, so the route keeps asking for exactly the one capability it
      // needs (and so TS can see the closure below is over a value already
      // known non-null, not the outer optional).
      const leaveChatForClaims = refs.adapterManager;
      deps.unclaimedChats = {
        store: unclaimedChatsStore,
        bindingStore: bindingStoreForClaims,
        ...(refs.meshCore && { meshCore: refs.meshCore }),
        ...(lifecycleForClaims && { lifecycle: lifecycleForClaims }),
        ...(leaveChatForClaims && {
          leaveChat: (adapterId: string, chatId: string) =>
            leaveChatForClaims.leaveChat(adapterId, chatId),
        }),
      };
    }
    setRelayEnabled(true);

    // Wire relay events to unified SSE stream
    refs.relayCore.subscribe('relay.human.console.>', (envelope) => {
      eventFanOut.broadcast('relay_message', envelope);
    });

    refs.relayCore.onSignal('relay.human.console.>', (_subject, signal) => {
      const eventType = signal.type === 'backpressure' ? 'relay_backpressure' : 'relay_signal';
      eventFanOut.broadcast(eventType, signal);
    });

    eventFanOut.broadcast('relay_connected', {
      pattern: 'relay.human.console.>',
      connectedAt: new Date().toISOString(),
    });

    mountedRouters.push('relay');
  }

  // Session-origin overlays (session-origin-legibility, team-room-home §D2.3):
  // two narrow batched lookups, mirroring the meshCore/relayCore pattern. Each
  // is its own read rather than a widening of any bag: a session list asks one
  // question of the rooms domain ("is this id a room's turn?") and one of Tasks
  // ("is this id a scheduled run?"), and answering them must not drag either
  // store into the session router's imports. A Tasks-disabled install leaves
  // the second unset, which both overlays treat as a safe no-op.
  //
  // Wired to the session routes (`deps.sessions`) AND to the global session-list
  // stream below, because both produce client-visible session rows and a room
  // turn must read the same way whichever one a client heard it from (DOR-1141).
  const origins: SessionOriginResolvers = {};
  if (refs.taskStore) {
    origins.resolveTaskOrigins = (sessionIds: string[]) =>
      refs.taskStore!.resolveTaskOrigins(sessionIds);
  }
  origins.resolveRoomOrigins = (sessionIds: string[]) => roomStore.resolveRoomOrigins(sessionIds);
  // Who started a chat (spec `flow-multiproject` §7.7): the third overlay, a
  // batched read of `session_started_by`, and the extension names its first
  // line says.
  origins.resolveStartedBy = (sessionIds: string[]) =>
    getSessionStartedByStore()?.getMany(sessionIds) ?? new Map();
  origins.extensionNameOf = (extensionId: string) =>
    refs.extensionManager?.get(extensionId)?.manifest.name ?? extensionId;
  // What you did in each chat (spec `your-activity-first` D5): the fourth
  // overlay, a batched read of `session_touches`. Set before the broadcaster
  // takes its resolvers, so the live stream carries it exactly as the routes do.
  origins.resolveTouches = (sessionIds: string[]) =>
    getSessionTouchStore()?.resolve(sessionIds) ?? new Map();
  // Agents wake on a beat or an event (spec `heartbeats`); sets the beat-chat
  // label resolver, so it runs before the broadcaster takes its resolvers.
  heartbeats.startHeartbeats({
    routes: deps,
    origins,
    db,
    meshCore: () => refs.meshCore,
    rooms: roomService,
    roomAuthors,
    notifyDm,
    relay: () => refs.relayChannelDeps,
    commitments: commitments.service,
  });
  sessionListBroadcaster.setOriginResolvers({ ...origins });
  // Who may read each session's transcript (spec `audit-trail` §3.4): an
  // agent sees agent work, never a person's own chat.
  const { resolveTaskOrigins, resolveStartedBy } = origins;
  wireSessionVisibility({ db, accounts: auditAccounts, resolveTaskOrigins, resolveStartedBy });
  // Live session upserts carry the flow items a chat works on, exactly as
  // `GET /api/sessions` does, so the first upsert after a list read no longer
  // wipes them from the client's cache (spec `flow-multiproject` §6.8, D10).
  // The live variant never runs git: a folder not resolved yet is resolved in
  // the background and its next event carries the items.
  sessionListBroadcaster.setTrackerItemsOverlay(applyTrackerItemsLive);

  // The project registry's feeds (spec `flow-multiproject` §6.1): seeded from
  // agents, workspaces and installs, then fed by every live session. Its store
  // was attached right after the database opened.
  startProjectRegistry(projectRegistry, {
    dorkHome,
    agentPaths: () => refs.meshCore?.listWithPaths().map((agent) => agent.projectPath) ?? [],
    workspaceSources: () =>
      refs.managedWorkspaces?.list().map((workspace) => workspace.source) ?? [],
  });

  // Which room an Ask came from, for the two surfaces that answer that question:
  // the live fan-out of `interaction_pending`, and the list a window reads on
  // mount. Both take the ledger as a PORT — neither the broadcaster nor the
  // session routes may reach into the rooms domain — so this one line is where
  // the rooms half of a fleet-wide prompt is decided.
  sessionListBroadcaster.setRoomBindings(roomStore.sessionLedger);

  // And where a room conversation RUNS, for the other surface that can start a
  // turn in one: the app's `POST /api/sessions/:id/messages` (DOR-1624). Same
  // port doctrine as the line above — the session route asks a room question
  // without importing a room type — and the same three reads the room-turn path
  // makes, so both answer the one worktree.
  refs.roomSessionPlacePort = roomSessionPlace({
    bindings: roomStore.sessionLedger,
    authors: roomAuthors,
    worktrees: () => roomWorktrees,
    sessionRuntime: (sessionId) => runtimeRegistry.resolveForSession(sessionId),
  });

  // The session relay answers the owner's own DorkOS on the web with the same
  // origin lookups and room port the session routes use, so a room turn, a
  // task run or a beat reads the same there as here (spec
  // `everything-is-a-space` B2). Read per request, never copied.
  wireSessionRelay({
    meshCore: () => refs.meshCore,
    origins,
    roomSessionPlace: () => refs.roomSessionPlacePort,
  });
  // Switching Chat from the web off closes a live relay at once.
  watchSessionRelaySwitch();

  // Wire global session-list discovery → unified SSE stream (ADR-0265/0266).
  // ALWAYS ON: fans every registered runtime's transition-only session-list
  // stream (session_upserted/session_removed/session_status) onto /api/events
  // (ADR-0310 fan-in). This layer adds no poll of its own; a runtime beneath it
  // may still run one, and the Claude Code adapter now does — a reconcile sweep
  // that re-reads its projects directories because chokidar drops what happens
  // while it is attaching (DOR-577). It changes nothing here: the sweep is a
  // source of rescans, and what reaches this fan-in is still transitions only.
  // Started here because all runtimes are registered by this point.
  // The registry is passed as the settings store too: every broadcast session
  // carries the operator's persisted mode/model, so a client refreshing its
  // list from this stream agrees with GET /api/sessions (DOR-463).
  sessionListBroadcaster.start(runtimeRegistry.listRuntimes(), runtimeRegistry);
  logger.info('[SessionList] Discovery broadcaster started');

  // Project turns the agent starts on its own onto the session's durable stream
  // (spec `warm-process-lifecycle` D6). A warm process keeps working after a
  // reply ends — a background helper finishes and its report is delivered — and
  // without this those words are read off the stream and dropped, so the person
  // watches a finished turn and never learns what their agent said next.
  //
  // Here for the same reason the broadcaster is: every runtime is registered by
  // this point, and a runtime that cannot produce such a turn omits the hook and
  // subscribes to nothing.
  for (const runtime of runtimeRegistry.listRuntimes()) subscribeRuntimeTurns(runtime);

  // Mesh routes if MeshCore initialized successfully (always-on, ADR-0062)
  // taskStore/relayCore power topology enrichment (relay badges, task counts);
  // when a subsystem is disabled the routes degrade to safe defaults.
  if (refs.meshCore) {
    deps.mesh = {
      meshCore: refs.meshCore,
      taskStore: refs.taskStore,
      relayCore: refs.relayCore,
      activity: activityService,
    };
    mountedRouters.push('mesh');
  }
  // The session routes' reads: the registry `/recent` resolves agent project
  // paths from (DOR-329), the room ports, and the same origin overlays the
  // session-list stream carries, so a room turn reads the same either way
  // (DOR-1141).
  deps.sessions = {
    ...origins,
    meshCore: refs.meshCore,
    roomSessionBindings: roomStore.sessionLedger,
    roomSessionPlace: refs.roomSessionPlacePort,
  };

  // Deep health (`GET /api/health/deep`) — the checks `dorkos doctor --deep`
  // cannot run from outside because they need this process's own view of rooms,
  // messaging, integrations, and agents. Handed over as one bag of narrow reads,
  // set after every subsystem above has had its chance to start; whatever is off
  // simply reports its checks skipped. Nothing here runs until a request asks.
  deps.deepHealth = {
    dorkHome,
    roomSessions: roomStore,
    // The boot sweep's own probe, so the two cannot disagree (DOR-805).
    // Undefined without the claude-code runtime, and the check then says it was
    // skipped rather than judging every binding with nothing to judge it by.
    roomBindingTranscripts: refs.roomBindingTranscripts,
    relay: refs.relayCore,
    adapters: refs.adapterManager,
    mesh: refs.meshCore,
    // An absent subsystem cannot say why it is absent, and "you never turned
    // this on" and "this was meant to be running and crashed" want opposite
    // reactions. Both catches above leave the object undefined, so the reason
    // has to be reconstructed here from what was asked for.
    relayFailedToStart: relayEnabled && !refs.relayCore,
    adaptersFailedToStart: relayEnabled && Boolean(refs.relayCore) && !refs.adapterManager,
    meshFailedToStart: !refs.meshCore,
    // Every installation, verified against what was installed (DOR-2197): the
    // same one-entry-per-installation scan the Installed view lists.
    installedPackages: {
      listIntegrity: async () => {
        const scopes = (refs.meshCore?.listWithPaths() ?? []).map((a) => ({
          projectPath: a.projectPath,
          id: a.id,
          name: a.displayName ?? a.name,
        }));
        const verified = await withIntegrity(await scanInstallationsAcrossScopes(dorkHome, scopes));
        return verified.map(({ name, integrity }) => ({ name, integrity }));
      },
    },
    // The same once-per-process read the startup warning logged (DOR-2326).
    gitProtection: installedGitProtection,
  };

  // The same live reads, for `GET /api/debug/*`. A separate bag from the one
  // above and deliberately so: deep health ANSWERS questions ("is anything
  // broken?"), and this one hands over raw state for a person to read. They
  // overlap today; conflating them would mean a new debug read could only be
  // added by widening the health checks' dependency surface.
  deps.debug = {
    docChannelMetrics,
    roomSessions: roomStore,
    // The SAME probe object the boot sweep and the deep health check hold, so
    // the raw debug read and the doctor cannot say different things about one
    // binding without the response naming why (DOR-1780).
    roomBindingTranscripts: refs.roomBindingTranscripts,
    transcriptProjectRoots: () =>
      refs.claudeRuntime?.getTranscriptReader().getProjectsRootSet() ?? [],
    ...(refs.relayCore ? { relayTraceStore: refs.traceStore } : {}),
  } satisfies DebugDeps;

  // Shape schedule service — file-first schedule creator + re-binder the Shape
  // apply flow and the agent-create seam share. Built here (not just inside the
  // marketplace block below) so the agent-create re-bind works even when the
  // extension manager is off. Degrades to a no-op stub when Tasks is disabled.
  const shapeScheduleService: ShapeScheduleServiceLike =
    refs.taskStore && refs.taskRegistrar
      ? new ShapeScheduleService({
          taskStore: refs.taskStore,
          registrar: refs.taskRegistrar,
          meshCore: refs.meshCore,
          dorkHome,
          logger,
        })
      : {
          listSchedules: () => [],
          createSchedule: async () => ({ created: false, reason: 'schedules-disabled' }),
          rebindSchedule: async () => undefined,
          deleteSchedulesForShape: async () => [],
        };

  // The agent-created seam (module-level, registered once at bootstrap): every
  // creation path — HTTP routes, MCP create_agent, marketplace agent install —
  // notifies it via `createAgentWorkspace` / the register route. Reaction: when
  // a new agent is created/registered, re-target any Shape schedule that was
  // created global/disabled because this agent was missing (spec item 3). The
  // 15-minute Linear tick turns on the moment "Linear Keeper" is created — no
  // re-apply. The notify is awaited (so creation responses reflect the settled
  // re-bind) but failures are swallowed at the seam; creation never fails
  // because this reaction threw. A schedule silently starting to run is
  // consequential, so a successful re-bind also lands in the activity feed.
  // Two independent reactions ride this one seam, and the room join goes first
  // because it is the one a person sees: a new agent is in your team room by
  // the time the creation response lands, without a restart (team-room-home
  // spec D3.1). It swallows its own failures, so a room that could not seat the
  // agent never costs the Shape re-bind below. Marking the moment comes straight
  // after the seat and in that order deliberately: "tangerines joined your team"
  // is a line about a member of the room, so the roster is settled before the
  // room says so (team-room-home spec D5.1).
  const announceEveryAgentInheritance = createEveryAgentArrivalReaction({
    activity: activityService,
    everyAgentGrants: () => connectorOperatorQueries.everyAgentGrants(connectorOwner),
  });
  // Set once the permission service exists, below. Every arrival path
  // (create, the register route, the mesh_register tool, a discovery scan)
  // reaches the listener, so this is where an arriving folder's own
  // permission settings are screened (review D1).
  const arrivalScreen: { run?: (agentId: string) => Promise<{ written: boolean }> } = {};
  const onArrival = createArrivalStep({
    arrivals: arrivalRecord,
    screen: () => arrivalScreen.run,
    logger,
  });
  setOnAgentCreated(async (agent: CreatedAgentInfo) => {
    // Marks the agent pending before anything awaits, so every reader narrows
    // its folder's settings until the screened ones are in its file.
    await onArrival(agent.id);
    joinTeamRoom(teamRoomDeps, agent.path);
    // Every arrival path funnels here, so this is where an agent that inherits
    // apps shared with every agent is announced — never silently (ADR
    // 260926-192625). A failure must not fail the arrival.
    await announceEveryAgentInheritance(agent).catch((err: unknown) =>
      logger.warn('[Connectors] Could not record every-agent inheritance', { err })
    );
    momentDetectors.agentCreated(agent);
    // Migrate anything this agent's project still keeps in the old shape, then
    // watch its `.agents/skills/` — NOW rather than at the next restart. Boot
    // used to be the only place roots were attached, so a schedule shipped with
    // a just-installed agent was invisible for the rest of the process's life.
    // Awaited so the roots are live before the Shape re-bind below writes into
    // them.
    await refs.attachAgentTaskRoots?.(agent.path, agent.id);
    // Set the PROJECT up for the agent tool DorkOS runs there. Pointing an agent
    // at a repository used to trigger nothing at all, so a project that had only
    // ever run another tool got a managed session that had never read its own
    // `AGENTS.md` (DOR-1901). Awaited, so the registration response reflects a
    // tree that is already set up; it swallows its own failures, and stands down
    // for a workspace the create pipeline built (it projects that one itself,
    // and would lose the write-if-absent race to this), for agent homes, and
    // for anything outside the boundary.
    await runAgentCreatedProjection(agent, { dorkHome });
    const rebound = await rebindShapeSchedulesForAgent(agent, {
      listShapes: () => listInstalledShapeManifests(dorkHome),
      scheduleService: shapeScheduleService,
    });
    if (rebound.length === 0) return;
    logger.info(`[Shapes] Re-bound ${rebound.length} schedule(s) to new agent '${agent.name}'`, {
      schedules: rebound,
    });
    const agentLabel = agent.displayName ?? agent.name;
    await activityService.emit({
      actorType: 'system',
      actorLabel: 'DorkOS',
      category: 'tasks',
      eventType: 'tasks.schedules_rebound',
      resourceType: 'agent',
      resourceId: agent.id,
      resourceLabel: agentLabel,
      summary:
        rebound.length === 1
          ? `Turned on a scheduled task for ${agentLabel}`
          : `Turned on ${rebound.length} scheduled tasks for ${agentLabel}`,
      linkPath: '/tasks',
      metadata: { schedules: rebound },
    });
  });

  // The fourth way an agent arrives: a discovery scan walks past a
  // `.dork/agent.json` this machine had never registered, and adopts it. That
  // agent used to sit outside the team room until the next boot's backfill
  // picked it up (DOR-1042). Mesh fires this ONLY on the pass that first
  // registers an id — never on a re-scan of an agent it already knows, never on
  // a relocation, and never on a refused duplicate — so the seat is taken once
  // and stays taken. Fire-and-forget: the scan is a background walk with nobody
  // waiting on a response, and `notifyAgentCreated` swallows its own failures,
  // so the promise cannot reject.
  //
  // `origin: 'registered'` is the load-bearing word. A scan finding a directory
  // is DorkOS updating its own records, not a person adding a teammate, so this
  // takes the seat silently — a scan that adopts a folder full of agents must
  // not spend the quiet hour announcing whichever one the walk reached first.
  refs.meshCore?.onAgentAdopted(
    (agent: AdoptedAgent) => void notifyAgentCreated({ ...agent, origin: 'registered' })
  );

  // Managed-MCP OAuth loopback callback (DOR-942) — the `redirect_uri` the
  // operator's browser lands on after authorizing a server, served by the Hono
  // app beside the agents group; the sign-in itself is driven by the
  // `mcp.signin`/`mcp.poll_signin` capabilities, not a route.
  if (refs.agentMcpOAuthService) deps.mcpOAuth = refs.agentMcpOAuthService;

  // Permissions (spec `agent-permissions` D10): the one way in for what agents
  // may do. Served by the Hono app, beside the agents group under
  // `/api/agents`. The registry is read lazily: it is composed after the
  // routes are handed over.
  // The one owner of every permission write (spec `agent-permissions` D10):
  // the permissions pages and the request card's Always allow both write here.
  const permissionService = createPermissionService({
    config: configManager,
    mesh: () => refs.meshCore,
    registry: () => refs.capabilityRegistry,
    activity: activityService,
    observer: permissionObserver,
    arrivals: arrivalRecord,
    personSet: personSetPermissions,
  });
  // The person-set floor is seeded once, on the first boot that has it, from
  // what each agent's file holds and what the history says a person set
  // (DOR-3107). Run by the caller once the capability registry is composed, so
  // the seed compares against the same action catalog the live reader does.
  // Until it lands every agent's floor is the defaults.
  const seedPersonSet = (): Promise<void> =>
    seedPersonSetOnBoot({
      personSet: personSetPermissions,
      mesh: () => refs.meshCore,
      activity: activityService,
      config: configManager,
      registry: () => refs.capabilityRegistry,
    }).catch((err: unknown) =>
      logger.warn('[Permissions] could not seed what a person set for each agent', {
        err: err instanceof Error ? err.message : String(err),
      })
    );
  arrivalScreen.run = (agentId) => permissionService.screenArrivedAgent(agentId);
  // A screen interrupted by a restart, or one whose write failed, is retried
  // now; its agent stays narrowed until one lands.
  for (const agentId of arrivalRecord.pendingIds()) {
    if (!refs.meshCore?.get(agentId)) {
      arrivalRecord.clear(agentId);
      continue;
    }
    void arrivalScreen
      .run(agentId)
      .then((screened) => {
        if (screened.written) arrivalRecord.clear(agentId);
      })
      .catch(() => undefined);
  }
  // An agent that leaves is forgotten by both records, so a later folder
  // reusing its id is screened as the newcomer it is.
  refs.meshCore?.onUnregister((agentId) => {
    arrivalRecord.clear(agentId);
    void permissionObserver.forget(agentId);
  });
  deps.permissions = { permissions: permissionService, activity: activityService };
  mountedRouters.push('permissions');

  // What agents promised (spec `heartbeats` §12). Always mounted, by the Hono
  // app: the list at `/api/commitments`, a person's new one per agent at
  // `/api/agents/:id/commitments`.
  deps.commitments = commitments.routeDeps;
  // Pause an agent everywhere, and lift it (spec `audit-trail` PR5). Served by
  // the Hono app, beside the agents group under `/api/agents`; the registry is
  // read lazily because it is composed after the routes are handed over.
  deps.agentPause = { registry: () => refs.capabilityRegistry };
  mountedRouters.push('agent-pause');

  // Always mounted — not behind any feature flag.
  // ADR-0043: pass meshCore (when available) so writes sync to Mesh DB cache.
  // The confirmation provider is composed further down this boot, inside the
  // marketplace block; read lazily so an agent's template creation raises a card
  // once it exists and fails closed until then (DOR-2325).
  deps.agents = {
    meshCore: refs.meshCore,
    activity: activityService,
    confirmationProvider: () => refs.templateConfirmationProvider,
    marketplace: () => refs.agentPackageInstaller,
  };
  return {
    connectorOwnerBoundary,
    connectorRoutes,
    shapeScheduleService,
    permissionService,
    seedPersonSet,
  };
}

/** What {@link mountCoreRoutes} hands the steps after it. */
export type MountCoreRoutesResult = ReturnType<typeof mountCoreRoutes>;
