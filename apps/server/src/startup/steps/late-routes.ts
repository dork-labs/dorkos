/**
 * The remaining route dependencies: team, profile, search, approvals, activity,
 * notifications, extensions, A2A, admin, the marketplace and the terminal.
 *
 * Moved out of `index.ts` unchanged; it runs at the same point in `start()`.
 *
 * @module startup/steps/late-routes
 */
import { listRecentSessions } from '../../services/session/index.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import {
  readOwnerAccount,
  getUserById,
  setUserImage,
  setUserName,
} from '../../services/core/auth/index.js';
import { configManager } from '../../services/core/config-manager.js';
import { LocalAvatarStore } from '../../services/identity/local-avatar-store.js';
import { resolveCaller } from '../../routes/room-caller.js';
import { logConfigWrite } from '../../services/core/operator/config-write.js';
import { env } from '../../env.js';
import { checkA2aExposure } from '../../services/core/auth/exposure-guard.js';
import { hasAnyUser } from '../../services/core/auth/index.js';
import { logger } from '../../lib/logger.js';
import { startMarketplace } from '../marketplace.js';
import { TerminalManager } from '../../services/terminal/index.js';
import type { WireMcpTasksAndSkillsResult } from './mcp-tasks-skills.js';
import type { WireRoomsResult } from './rooms.js';
import type { ClaimDataDirectoryResult } from './data-directory.js';
import type { OpenConfigAndDatabaseResult } from './config-and-database.js';
import type { WireConnectorEventsAndApprovalsResult } from './connector-events-approvals.js';
import type { WireCoreStoresResult } from './core-stores.js';
import type { MountCoreRoutesResult } from './core-routes.js';
import type { WireSessionServicesResult } from './session-services.js';
import type { StartTelemetryExtensionsAndRuntimesResult } from './telemetry-extensions-runtimes.js';
import type { ServerRefs } from '../server-refs.js';

/** What {@link mountLateRoutes} reads from the startup steps before it. */
export interface MountLateRoutesInput {
  deps: WireMcpTasksAndSkillsResult['deps'];
  roomAuthors: WireRoomsResult['roomAuthors'];
  roomStore: WireRoomsResult['roomStore'];
  roomService: WireRoomsResult['roomService'];
  dorkHome: ClaimDataDirectoryResult['dorkHome'];
  db: OpenConfigAndDatabaseResult['db'];
  approvalService: WireConnectorEventsAndApprovalsResult['approvalService'];
  mountedRouters: string[];
  activityService: WireCoreStoresResult['activityService'];
  permissionService: MountCoreRoutesResult['permissionService'];
  auditLog: WireCoreStoresResult['auditLog'];
  auditAccounts: WireCoreStoresResult['auditAccounts'];
  notificationService: WireSessionServicesResult['notificationService'];
  pushSubscriptions: WireSessionServicesResult['pushSubscriptions'];
  webPushChannel: WireSessionServicesResult['webPushChannel'];
  PORT: number;
  shutdownServices: () => Promise<void>;
  shapeScheduleService: MountCoreRoutesResult['shapeScheduleService'];
  legacyRecordSweep: AbortController;
  resolvedBoundary: StartTelemetryExtensionsAndRuntimesResult['resolvedBoundary'];
}

/**
 * Fill in the remaining route dependencies and start the marketplace and terminal.
 *
 * @param refs - The server's live references, which shutdown reads.
 * @param built - What the steps before this one built.
 */
export async function mountLateRoutes(refs: ServerRefs, built: MountLateRoutesInput) {
  const {
    deps,
    roomAuthors,
    roomStore,
    roomService,
    dorkHome,
    db,
    approvalService,
    mountedRouters,
    activityService,
    permissionService,
    auditLog,
    auditAccounts,
    notificationService,
    pushSubscriptions,
    webPushChannel,
    PORT,
    shutdownServices,
    shapeScheduleService,
    legacyRecordSweep,
    resolvedBoundary,
  } = built;
  // The team roster — one READ of every identity on this install (ADR
  // 260806-222535). Always mounted, and mounted even when the mesh did not
  // start: the person reading the page is on the roster, so a missing agent
  // registry is a `warnings[]` entry rather than a dead route. Served from the
  // Hono `/api` app (`http/hono-api.ts`), which reads this.
  deps.team = {
    authors: roomAuthors,
    // `GET /api/team/:memberId/rooms` — where one member can be found (spec
    // `profile-unification` §3.2). The store rather than `RoomService`: this
    // is two membership reads and no room behaviour.
    rooms: roomStore,
    ...(refs.meshCore && { meshCore: refs.meshCore }),
    // What is working RIGHT NOW, from the one map that knows: the room
    // dispatcher's claims. Nothing else on this install can answer it.
    activeClaims: () => roomService.listActiveClaims(),
    // Archived included on purpose — a room can be archived while an agent is
    // still mid-turn in it, and the status sentence should still name it.
    listRooms: () =>
      roomStore
        .listRooms({ includeArchived: true })
        .map((room) => ({ id: room.id, name: room.title })),
    // When each agent last ran, for the agents mesh health cannot speak for
    // (it is stamped by the claude-code turn paths only). `limit: 1` because
    // only the `agentActivity` map is wanted here — it is computed across
    // every session before that trim, so the map is complete either way.
    sessionActivity: async () => {
      const { agentActivity } = await listRecentSessions({
        runtimes: runtimeRegistry.listRuntimes(),
        agentPaths: refs.meshCore ? refs.meshCore.listWithPaths().map((a) => a.projectPath) : [],
        limit: 1,
      });
      return agentActivity;
    },
    ownerAccount: () => readOwnerAccount(),
    ownerEmail: (userId) => getUserById(userId)?.email ?? null,
    // `config.profile.displayName` is what the user likes to be called — the
    // second rung of the operator-name precedence, under the account name.
    configDisplayName: () => configManager.getAll().profile.displayName,
    configDisplayNameSource: () => configManager.getAll().profile.displayNameSource,
    defaultAgentName: () => configManager.getAll().agents.defaultAgent,
  };

  // The operator's own profile — their photo and their name (spec
  // `identity-consistency` §W3.3, §W3.5). The store is chosen HERE and nowhere
  // else: the router depends on the `AvatarStore` interface, so the day photos
  // live somewhere other than this machine, this line is what changes. Served
  // from the Hono `/api` app (`http/hono-api.ts`), which reads this.
  deps.profile = {
    avatars: new LocalAvatarStore(dorkHome),
    caller: (request, access) => resolveCaller(request, access),
    authors: roomAuthors,
    ownerAccount: () => readOwnerAccount(),
    setAccountImage: (userId, imageUrl) => setUserImage(userId, imageUrl),
    setAccountName: (userId, name) => setUserName(userId, name),
    setProfileDisplayName: (displayName, source) => {
      const before = configManager.get('profile');
      // The name and the record of who wrote it go in ONE write, so no reader
      // can catch the new name still carrying the previous writer's stamp.
      // `set` rather than two `setDot`s for exactly that reason (DOR-1022);
      // WHICH source is the route's call, not this line's.
      configManager.set('profile', { ...before, displayName, displayNameSource: source });
      logConfigWrite('the profile route', 'profile', before, configManager.get('profile'));
    },
  };

  // Message search — "where did we talk about X", over the derived index the
  // reconciler above keeps caught up (message-search spec §6, §7). Always
  // mounted and read-only. An install whose index is empty answers `[]`, which is
  // the honest answer and needs no flag; who may see what is resolved per request
  // through the rooms domain, never from this line.
  deps.search = { db };

  // Template catalog — always available, merges built-in + user templates.
  // Served from the Hono `/api` app, like the saved chat folders beside it.
  deps.templates = { dorkHome };
  deps.sessionLocations = db;

  // Harness Sync — "what does every agent tool do with every agent file in this
  // project", and the Sync now button that acts on it. The GET writes nothing
  // (DOR-678's rule, stated in the route); the POST is person-only and takes
  // the project lock. The approval service is what lets the sync ask about a
  // package's hooks, exactly as the install path does.
  deps.harness = { dorkHome, approvals: approvalService };
  mountedRouters.push('harness');

  // Approvals — always available. The cockpit lists what is waiting on a person
  // and records their decision (spec `agent-trust` §3.3).
  deps.approvals = {
    service: approvalService,
    options: {
      activity: activityService,
      // An "Always allow" writes through the one permission write owner, like
      // Settings does (spec `agent-permissions` D7).
      permissions: permissionService,
      // Names the action for the answer's audit line. Read lazily: the registry
      // is composed later in boot.
      describeCapability: (capabilityId) => refs.capabilityRegistry?.get(capabilityId),
    },
  };

  // Activity feed — always available, not behind a feature flag.
  deps.activity = activityService;
  deps.audit = { log: auditLog, accounts: auditAccounts };
  mountedRouters.push('activity');

  // The Inbox — always available for the same reason: the history is written
  // whether or not any channel could carry it.
  deps.notifications = notificationService;
  mountedRouters.push('notifications');

  // Web push — how the escalation ladder reaches a browser DorkOS is not open
  // in. Always mounted: a person can subscribe a device before anything has ever
  // needed to escalate, and the routes are what tell the Settings tab whether
  // this install can push at all.
  deps.push = { subscriptions: pushSubscriptions, channel: webPushChannel };
  mountedRouters.push('push');

  // The bell and the Activity inbox answer extension decisions here (spec
  // `flow-multiproject` §7.3). Always mounted: with no extension system it
  // simply lists nothing.
  deps.extensionDecisions = { activity: activityService };
  mountedRouters.push('extension-decisions');

  // Extensions — managing them, and each running extension's own API under
  // `/api/ext/:id/*` — when the extension system initialized successfully.
  if (refs.extensionManager) {
    deps.extensions = {
      manager: refs.extensionManager,
      dorkHome,
      getCwd: () => env.DORKOS_DEFAULT_CWD ?? null,
    };
    mountedRouters.push('extensions');
  }

  // Discovery routes when MeshCore is available (delegates to meshCore.discover())
  if (refs.meshCore) {
    deps.discovery = refs.meshCore;
    mountedRouters.push('discovery');
  }

  // Mount A2A gateway if enabled — requires both Relay (message routing) and Mesh (agent registry)
  //
  // The gate is `a2a.enabled` in config, with `DORKOS_A2A_ENABLED` winning in
  // BOTH directions when it is present — the same shape Tasks and Relay use
  // above, so a headless deployment keeps deciding from its environment and the
  // Experiments section can honestly report the setting as locked (DOR-1304).
  const a2aEnabled =
    // eslint-disable-next-line no-restricted-syntax -- Checking presence, not value: env.ts can't distinguish "unset" from "set to false"
    'DORKOS_A2A_ENABLED' in process.env
      ? env.DORKOS_A2A_ENABLED
      : (configManager.get('a2a')?.enabled ?? false);
  if (a2aEnabled && refs.relayCore && refs.meshCore) {
    // The A2A surface is guarded by decideMcpAuth for the 'a2a' surface. For a
    // person at this computer the per-instance local token gates JSON-RPC execution, but
    // that token is a loopback-trust mechanism (a 0600 file only a local operator
    // can read) — it does not make the surface safe on a non-loopback bind. So the
    // exposure guard still keys off a network-reachable credential (an env key,
    // the legacy compat key, or an owner account, whose key every other device
    // must present) to decide whether A2A may mount off loopback.
    //
    // This answers "may A2A face the network?" and nothing else. It is NOT what
    // Agent Cards advertise: execution is gated in every posture, so cards state
    // the bearer requirement unconditionally (DOR-1824, agent-card-generator.ts).
    const authConfigured =
      !!env.MCP_API_KEY?.trim() || !!configManager.get('mcp')?.apiKey || hasAnyUser();

    // Exposure guard: refuse to mount the external A2A surface (JSON-RPC plus
    // the agent-card discovery endpoints) on a non-loopback host when nothing
    // gates it — otherwise remote prompt execution against every agent would be
    // open to the network. Unlike the bind check this is not a hard exit: the
    // loopback cockpit stays usable; only the A2A surface is withheld.
    const a2aExposure = checkA2aExposure({
      host: env.DORKOS_HOST,
      authConfigured,
      allowInsecureBind: env.DORKOS_ALLOW_INSECURE_BIND,
    });
    if (!a2aExposure.allowed) {
      logger.error(`[A2A] ${a2aExposure.reason}`);
      // Also to stderr so an operator starting from a terminal sees why the
      // surface they enabled did not come up.
      console.error(`\n${a2aExposure.reason}\n`);
    } else {
      if (a2aExposure.warning) logger.warn(`[A2A] ${a2aExposure.warning}`);

      // Advertised card URL: prefer the explicit public URL — behind a proxy or
      // tunnel the {host}:{port} bind is non-routable (e.g. http://0.0.0.0:PORT).
      // Trailing slashes are stripped so `${baseUrl}/a2a` stays clean.
      const baseUrl = (env.DORKOS_PUBLIC_URL ?? `http://${env.DORKOS_HOST}:${PORT}`).replace(
        /\/+$/,
        ''
      );
      // The cards, the JSON-RPC endpoints and their own gates (the credential
      // check and the two limiters) answer from the Hono chain: `routes/a2a.ts`.
      deps.a2a = {
        meshCore: refs.meshCore,
        relay: refs.relayCore,
        db,
        baseUrl,
        version: env.DORKOS_VERSION_OVERRIDE ?? '0.0.0',
        rpcMaxPerMinute: env.DORKOS_A2A_RPC_RATE_LIMIT,
        cardMaxPerMinute: env.DORKOS_A2A_CARD_RATE_LIMIT,
      };

      // Names the credential a caller must send. "none" was never true here —
      // execution is gated in every posture; only WHICH credential changes.
      // With login OFF but an env/legacy key set, acceptor 4 in mcp-auth.ts is
      // gated on `!authEnabled` — not on the key — so the local token still
      // passes there too. Name every credential that works, or the line trades
      // one lie for a smaller one.
      const a2aAuthMode = authConfigured
        ? 'auth: API key, login, or local MCP token'
        : 'auth: local MCP token (loopback)';
      logger.info(
        `[A2A] Gateway mounted (fleet card: /.well-known/agent-card.json, RPC: POST /a2a, ${a2aAuthMode})`
      );
    }
  }

  // Admin routes (reset, restart)
  deps.admin = { dorkHome, shutdownServices, closeDb: () => db.$client.close() };
  mountedRouters.push('admin');

  // Mount Marketplace routes. The install pipeline has two optional
  // collaborators — `extensionManager` (needed by plugin + uninstall flows)
  // and `adapterManager` (needed by adapter + uninstall flows). When either
  // is absent the corresponding flows will surface a clear error on call,
  // but source listing, cache, discovery, agent installs, and skill-pack
  // installs remain fully functional, so we always mount the router rather
  // than gating the entire namespace.
  ({
    devLinkWatcher: refs.devLinkWatcher,
    templateConfirmationProvider: refs.templateConfirmationProvider,
    agentPackageInstaller: refs.agentPackageInstaller,
    marketplaceMcpDeps: refs.marketplaceMcpDeps,
  } = await startMarketplace({
    dorkHome,
    extensionManager: refs.extensionManager,
    adapterManager: refs.adapterManager,
    claudeRuntime: refs.claudeRuntime,
    approvalService,
    shapeScheduleService,
    projectInstallRecovery: refs.projectInstallRecovery,
    legacyRecordSweep,
    currentMeshCore: () => refs.meshCore,
    currentSweptProjects: () => refs.sweptProjects,
    currentCapabilityRegistry: () => refs.capabilityRegistry,
    mountedRouters,
    honoDeps: deps,
  }));

  // Embedded terminal (spec right-panel-workbench, Chunk E). Always mounted:
  // PTYs are boundary-confined to the requested cwd, and a terminal id is an
  // unguessable UUID minted only through this auth-gated POST — the WebSocket
  // (attached after listen) authenticates by bearer-of-id.
  // The detached-PTY grace window is operator-configurable (DOR-225): a longer
  // TTL keeps a shell reattachable across a slow reload; a shorter one reclaims
  // idle PTYs faster. Minutes in config → milliseconds for the manager.
  const terminalGraceTtlMinutes = configManager.get('workbench').terminalGraceTtlMinutes;
  refs.terminalManager = new TerminalManager({
    boundary: resolvedBoundary,
    idleTimeoutMs: terminalGraceTtlMinutes * 60_000,
  });
  deps.terminal = refs.terminalManager;
  mountedRouters.push('terminal');
  logger.info('[DorkOS] routes mounted', { routers: mountedRouters.join(' ') });
}
