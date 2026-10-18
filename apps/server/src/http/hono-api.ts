import { createLocalBrowserRoutes } from '../routes/local-browser.js';
import type { LocalBrowserService } from '../services/session/local-browser/service.js';
/**
 * The server's routing: the chain (`http/api-chain.ts`) with every route group
 * mounted on it, and the client build behind them in production.
 *
 * {@link composeFrontDoor} builds it; `index.ts` serves it through the front
 * door (`http/front-door.ts`), and tests that need the server's real routing
 * build the same thing.
 *
 * @module http/hono-api
 */
import type { Hono } from 'hono';
import { env } from '../env.js';
import { clientDistPath } from './client-dist.js';
import { getAuth } from '../services/core/auth/index.js';
import type { MainRequestAdmission } from '../services/core/lifecycle/main-request-admission.js';
import { createApiApp, type ApiEnv } from './api-chain.js';
import { mountBetterAuth } from './better-auth.js';
import { mountDesktopSignIn } from './desktop-sign-in.js';
import { createClientFiles } from './client-files.js';
import { serveRouteCensus } from './route-census/census.js';
import type { Db } from '@dorkos/db';
import type { ActivityService } from '../services/activity/activity-service.js';
import type { CapabilityRegistry } from '../services/core/capabilities/index.js';
import type { NotificationService } from '../services/notifications/notification-service.js';
import type { ApprovalService } from '../services/core/approvals/index.js';
import type { MeshCore } from '@dorkos/mesh';
import type { AgentMcpOAuthService } from '../services/mesh/agent-mcp-oauth-service.js';
import {
  mountConnectorSignedIngress,
  type ConnectorSignedIngress,
} from '../services/connectors/events/signed-ingress.js';
import { createA2aRoutes, type A2aRouteDeps } from '../routes/a2a.js';
import { createActivityRoutes } from '../routes/activity.js';
import { createAdminRoutes, type AdminDeps } from '../routes/admin.js';
import { createAgentPauseRoutes, type AgentPauseRouterDeps } from '../routes/agent-pause.js';
import { createAgentsRoutes, type AgentsRouterDeps } from '../routes/agents.js';
import { createApprovalsRoutes, type ApprovalsRouterOptions } from '../routes/approvals.js';
import { createApiDocsRoutes } from '../routes/api-docs.js';
import { createConnectorRoutes, type ConnectorRoutesDeps } from '../routes/connectors.js';
import { createAuditRoutes, type AuditRouterDeps } from '../routes/audit.js';
import {
  canvasDocBodyRule,
  createCanvasDocEventRoutes,
  type DocChannelHttp,
} from '../routes/canvas-doc-events.js';
import capabilitiesRoutes from '../routes/capabilities.js';
import cloudRoutes from '../routes/cloud.js';
import { createCapabilitiesCatalogRoutes } from '../routes/capabilities-catalog.js';
import { createCapabilitiesInvokeRoutes } from '../routes/capabilities-invoke.js';
import commandRoutes from '../routes/commands.js';
import { createCommunityConnectionsRoutes } from '../routes/community-connections.js';
import configRoutes from '../routes/config.js';
import { mountComputerRoutes, type ComputerRoutesService } from '../routes/computers.js';
import {
  createAgentCommitmentsRoutes,
  createCommitmentsRoutes,
  type CommitmentRouterDeps,
} from '../routes/commitments.js';
import { createDebugRoutes, type DebugDeps } from '../routes/debug.js';
import diffRoutes from '../routes/diff.js';
import directoryRoutes from '../routes/directory.js';
import { createDiscoveryRoutes } from '../routes/discovery.js';
import errorRoutes from '../routes/errors.js';
import { createExtensionApiRoutes } from '../routes/extension-api.js';
import { createExtensionsRoutes, type ExtensionsRouterDeps } from '../routes/extensions.js';
import {
  createExtensionDecisionsRoutes,
  type ExtensionDecisionsRouterDeps,
} from '../routes/extension-decisions.js';
import feedbackRoutes, { feedbackBodyRule } from '../routes/feedback.js';
import { createFileRoutes } from '../routes/files.js';
import gitRoutes from '../routes/git.js';
import { createHarnessRoutes, type HarnessRouterDeps } from '../routes/harness.js';
import { createHealthRoutes, type HealthRouteDeps } from '../routes/health.js';
import { createHubComputerRoutes } from '../routes/hub-computers.js';
import { createHubLinkRoutes, hubLinkBodyRule } from '../routes/hub-link.js';
import { createHeartbeatRoutes, type HeartbeatRouterDeps } from '../routes/heartbeats.js';
import {
  createHeartbeatTriageRoutes,
  type HeartbeatTriageRouterDeps,
} from '../routes/heartbeat-triage.js';
import keepAwakeRoutes from '../routes/keep-awake.js';
import { createMarketplaceRoutes, type MarketplaceRouteDeps } from '../routes/marketplace.js';
import { createMcpRoutes, type McpServerFactory } from '../routes/mcp.js';
import mcpConfigRoutes from '../routes/mcp-config.js';
import { createMcpOAuthRoutes } from '../routes/mcp-oauth.js';
import { createSignInLandingRoutes } from '../routes/sign-in-landings.js';
import { createMeshRoutes, type MeshRouterDeps } from '../routes/mesh.js';
import { createMockMcpOAuthRoutes } from '../routes/mock-mcp-oauth-server.js';
import modelRoutes from '../routes/models.js';
import { createOnboardingRoutes, productionOnboardingDeps } from '../routes/onboarding.js';
import { createNotificationsRoutes } from '../routes/notifications.js';
import { createPermissionsRoutes, type PermissionsRouterDeps } from '../routes/permissions.js';
import { createProfileRouter, type ProfileRouterDeps } from '../routes/profile.js';
import projectRoutes from '../routes/projects.js';
import { createRuntimesRoutes } from '../routes/runtimes.js';
import { createPushRoutes, type PushRouterDeps } from '../routes/push.js';
import { createRelayRoutes, type RelayRouteDeps } from '../routes/relay.js';
import { relayWebhookBodyRule } from '../routes/relay-webhooks.js';
import readCursorRoutes from '../routes/read-cursors.js';
import roomRoutes from '../routes/rooms.js';
import { createDirectChatRoutes } from '../routes/direct-chats.js';
import { createRemoteAccessRoutes } from '../routes/remote-access.js';
import { createSessionRelayRoutes } from '../routes/session-relay.js';
import { createDocLinkRoutes } from '../routes/docs-links.js';
import { createRemoteCommunitiesRoutes } from '../routes/remote-communities.js';
import { createSearchRoutes, type SearchRouterDeps } from '../routes/search.js';
import { createSessionLocationsRoutes } from '../routes/session-locations.js';
import { createSessionRoutes, type SessionRouteDeps } from '../routes/sessions.js';
import { createShapesRoutes, type ShapesRouterDeps } from '../routes/shapes.js';
import subagentRoutes from '../routes/subagents.js';
import { createTasksRoutes, type TasksRouterDeps } from '../routes/tasks.js';
import { createSystemRoutes } from '../routes/system.js';
import { createTeamRoutes, type TeamRouterDeps } from '../routes/team.js';
import { createTemplateRoutes } from '../routes/templates.js';
import { createTerminalRoutes } from '../routes/terminal.js';
import type { TerminalManager } from '../services/terminal/index.js';
import { gateCommunityConnections, gateRemoteCommunities } from '../middleware/spaces-enabled.js';
import {
  createUnclaimedChatsRoutes,
  type UnclaimedChatsRouterDeps,
} from '../routes/unclaimed-chats.js';
import { createTestControlRoutes, type TestControlDeps } from '../routes/test-control.js';
import tunnelRoutes from '../routes/tunnel.js';
import { createLanAccessRoutes } from '../routes/lan-access.js';
import eventsRoutes from '../routes/events.js';
import uploadRoutes from '../routes/uploads.js';
import workbenchServeRoutes from '../routes/workbench-serve.js';
import workspaceRoutes from '../routes/workspaces.js';
import { isAgentComputer } from '../services/core/server-role/role-checks.js';

/**
 * The groups that are only mounted when the server hands over what they read.
 * A test that builds the server bare passes none of them, and those paths then
 * answer the `/api` 404.
 */
export interface ComposedGroupDeps {
  /** The team roster's reads (`/api/team`). */
  team?: TeamRouterDeps;
  /** The message index (`/api/search`). */
  search?: SearchRouterDeps;
  /** The activity feed (`/api/activity`). */
  activity?: ActivityService;
  /** The audit log and its account names (`/api/audit`). */
  audit?: AuditRouterDeps;
  /**
   * The composed capability registry, behind the catalog
   * (`GET /api/capabilities/catalog`) and the invoke endpoint
   * (`POST /api/capabilities/:id/invoke`). The runtime matrix
   * (`GET /api/capabilities`) needs none and is always mounted.
   */
  capabilities?: CapabilityRegistry;
  /** The install's database, behind the saved chat folders (`/api/session-locations`). */
  sessionLocations?: Db;
  /** The data directory the user's own templates live in (`/api/templates`). */
  templates?: { dorkHome: string };
  /** The agent-file status and Sync now (`/api/harness`). */
  harness?: HarnessRouterDeps;
  /**
   * Installed Shapes, and applying and forking them (`/api/shapes`). Only
   * handed over when the marketplace started (`startup/marketplace.ts`).
   */
  shapes?: ShapesRouterDeps;
  /**
   * Package sources, installs, updates, held-back packages and dev links
   * (`/api/marketplace`). Only handed over when the marketplace started
   * (`startup/marketplace.ts`).
   */
  marketplace?: MarketplaceRouteDeps;
  /** The Inbox (`/api/notifications`). */
  notifications?: NotificationService;
  /** Web push devices (`/api/push`). */
  push?: PushRouterDeps;
  /** Request cards and their answers (`/api/approvals`). */
  approvals?: { service: ApprovalService; options: ApprovalsRouterOptions };
  /** Answers to extension decisions (`/api/extension-decisions`). */
  extensionDecisions?: ExtensionDecisionsRouterDeps;
  /**
   * Managing extensions (`/api/extensions`) and each running extension's own
   * API (`/api/ext/:id/*`). Only handed over when the extension system
   * started. The Activity feed is {@link ComposedGroupDeps.activity}.
   */
  extensions?: Omit<ExtensionsRouterDeps, 'activity'>;
  /** What agents may do (`/api/permissions*`, `/api/agents/:id/permissions`). */
  permissions?: PermissionsRouterDeps;
  /** Pausing an agent everywhere (`/api/agents/pauses`, `/api/agents/:id/{pause,resume}`). */
  agentPause?: AgentPauseRouterDeps;
  /** The operator's photo and name (`/api/profile`). */
  profile?: ProfileRouterDeps;
  /** The agent registry's routes (`/api/mesh`). Only handed over when the mesh started. */
  mesh?: MeshRouterDeps;
  /**
   * An agent's Heartbeat page (`GET /api/agents/:id/heartbeat`). Handed over
   * when heartbeats start (`services/heartbeats`).
   */
  heartbeat?: HeartbeatRouterDeps;
  /**
   * The answer to "Run cheap checks on DorkOS credits?"
   * (`PUT /api/heartbeats/triage-credits`). Handed over with
   * {@link ComposedGroupDeps.heartbeat}.
   */
  heartbeatTriage?: HeartbeatTriageRouterDeps;
  /** The embedded terminal's REST half (`/api/terminal`); its socket is an upgrade. */
  terminal?: TerminalManager;
  computers?: ComputerRoutesService;
  localBrowser?: LocalBrowserService;
  /** Agent identity, by folder (`/api/agents`). */
  agents?: AgentsRouterDeps;
  /** The discovery scan stream (`/api/discovery`). Only handed over when the mesh started. */
  discovery?: MeshCore;
  /** Where a managed MCP server's sign-in lands (`/api/agents/mcp-oauth`). */
  mcpOAuth?: AgentMcpOAuthService;
  /** What agents promised (`/api/commitments`, `/api/agents/:id/commitments`). */
  commitments?: CommitmentRouterDeps;
  /**
   * Scheduled tasks and their runs (`/api/tasks`). Only handed over when Tasks
   * started (`startup/tasks.ts`).
   */
  tasks?: TasksRouterDeps;
  /** Every `/api/connectors` group (`routes/connectors.ts`). */
  connectors?: ConnectorRoutesDeps;
  /**
   * The signed webhook ingress (`POST /api/connectors/webhooks/:id`), which
   * answers to its signature before the body is parsed and before the session
   * gate.
   */
  connectorEventIngress?: ConnectorSignedIngress;
  /**
   * Builds the tool server behind the external MCP endpoint (`/mcp`), per
   * request. Not under `/api`, but behind the same chain.
   */
  mcp?: McpServerFactory;
  /**
   * Document events (`/api/canvas/docs`). Always mounted; without this every
   * request answers that document events are not available yet.
   */
  docChannel?: DocChannelHttp & { fileWrites?: Parameters<typeof createFileRoutes>[0] };
  /**
   * The agent registry first-run setup moves DorkBot's runtime through
   * (`/api/onboarding`, always mounted), for a boot that mounts no mesh routes
   * (the eval harness). Without it, the mesh routes' registry
   * ({@link ComposedGroupDeps.mesh}) is used; with neither, DorkBot's manifest
   * is still written, with no registry sync.
   */
  onboarding?: { meshCore: () => MeshCore | undefined };
  /** The live reads behind `GET /api/debug/*`, which is always mounted. */
  debug?: DebugDeps;
  /** Reset and restart (`/api/admin`), which end this process. */
  admin?: AdminDeps;
  /**
   * The test-control routes (`/api/test`). They are mounted whenever
   * `DORKOS_TEST_RUNTIME` is set, and on any server handed these, as the eval
   * harness's boot is.
   */
  testControl?: TestControlDeps;
  /**
   * The A2A gateway: the agent cards (`/.well-known/agent-card.json`, its
   * legacy alias, `/a2a/agents/:id/card`) and the JSON-RPC endpoints under
   * `/a2a`. Not under `/api`, but behind the same chain. Only handed over when
   * A2A is on, Relay and the mesh started, and the exposure guard allowed it.
   */
  a2a?: A2aRouteDeps;
  /**
   * What the session routes read (`/api/sessions`, always mounted): the agent
   * registry, the room ports and the origin overlays. The router keeps this
   * object and reads its fields per request, so a test may change a field
   * between requests (not swap the object).
   */
  sessions?: SessionRouteDeps;
  /**
   * The message bus, its connections and chat routes, and the webhook receiver
   * (`/api/relay`). Only handed over when Relay is enabled and started.
   */
  relay?: RelayRouteDeps;
  /**
   * The claim feed (`/api/relay/unclaimed-chats`). Only handed over with
   * {@link ComposedGroupDeps.relay}, and only when the binding subsystem came
   * up with its store.
   */
  unclaimedChats?: UnclaimedChatsRouterDeps;
}

/** What the moved route groups read from the running server, handed over by `index.ts`. */
export type HonoApiDeps = HealthRouteDeps & ComposedGroupDeps;

/** Options for {@link createHonoApi}. */
export interface HonoApiOptions {
  /** The main listener's shared terminal state. */
  admission: MainRequestAdmission;
  /** See {@link HonoApiDeps}. A test that builds the server bare passes none. */
  deps?: HonoApiDeps;
  /**
   * Where the client build is, when this server serves one: what answers a
   * page, a bundle and a deep link (`http/client-files.ts`). Omitted, nothing
   * outside the routes is served.
   */
  clientDist?: string;
}

/**
 * Build the Hono `/api` app with every moved group mounted.
 *
 * Better Auth is mounted whenever `initAuth` has run, even with login off, so
 * the enable-login flow can create the owner account before the flag flips,
 * except on an agent computer, where nobody signs in. A unit test that builds
 * the server without auth gets no auth routes.
 *
 * @param options - See {@link HonoApiOptions}.
 * @returns The app, ready for `createFrontDoor({ api })`.
 */
export function createHonoApi(options: HonoApiOptions): Hono<ApiEnv> {
  const auth = getAuth();
  const deps = options.deps ?? {};
  const docEventBodyRule = canvasDocBodyRule(() => deps.docChannel?.metrics);
  const app = createApiApp({
    admission: options.admission,
    // Feedback carries an opt-in screenshot, so it may be larger than the app-wide
    // limit; document events are page envelopes, so they may be smaller. A
    // signed Relay webhook keeps its raw bytes while its receiver is mounted.
    // A hub's link path is open before its code is checked, so it reads 4 KB.
    bodyRules: [feedbackBodyRule, docEventBodyRule, relayWebhookBodyRule, hubLinkBodyRule],
    clientFiles: options.clientDist ? createClientFiles(options.clientDist) : undefined,
    beforeBodyParsing: (early) => {
      // A sealed agent computer mounts nothing ahead of its gate (DOR-2940): no
      // sign-in, and no webhook for a connection, since none starts there.
      if (isAgentComputer()) return;
      if (auth) mountBetterAuth(early, { auth, maxAttempts: env.DORKOS_AUTH_SIGNIN_RATE_LIMIT });
      if (auth) mountDesktopSignIn(early, auth);
      if (deps.connectorEventIngress) {
        mountConnectorSignedIngress(early, deps.connectorEventIngress);
      }
    },
  });
  app.route('/api/health', createHealthRoutes(deps));
  // Sessions, their messages and the per-session stream. Its WebSocket twin on
  // `/:id/events` is an upgrade, answered before any route
  // (`routes/session-events-socket.ts`).
  app.route('/api/sessions', createSessionRoutes(deps.sessions ?? {}));
  // The global event stream over SSE. Its WebSocket twin on the same path is an
  // upgrade, answered before any route (`routes/events-socket.ts`).
  app.route('/api/events', eventsRoutes);
  app.route('/api/models', modelRoutes);
  app.route('/api/commands', commandRoutes);
  app.route('/api/subagents', subagentRoutes);
  app.route('/api/system', createSystemRoutes());
  app.route('/api/keep-awake', keepAwakeRoutes);
  app.route('/api/errors', errorRoutes);
  app.route('/api/directory', directoryRoutes);
  app.route('/api/git', gitRoutes);
  app.route('/api/workspaces', workspaceRoutes);
  app.route('/api/projects', projectRoutes);
  app.route('/api/read-cursors', readCursorRoutes);
  app.route('/api/rooms', roomRoutes);
  app.route(
    '/api/direct-chats',
    createDirectChatRoutes(() => deps.mesh?.meshCore)
  );
  // Spaces (rooms on another server) are an experiment, off by default
  // (DOR-2740): both groups refuse until a person turns `spaces.enabled` on,
  // except for the official space (spec `official-community-space` D5), which
  // each gate lets through by its `:ref`. A space's credentials stay here.
  app.use('/api/community-connections/*', gateCommunityConnections());
  app.route('/api/community-connections', createCommunityConnectionsRoutes());
  app.use('/api/communities/*', gateRemoteCommunities());
  app.route('/api/communities', createRemoteCommunitiesRoutes());
  app.route('/api/files', createFileRoutes(deps.docChannel?.fileWrites));
  app.route('/api/diff', diffRoutes);
  app.route('/api/workbench', workbenchServeRoutes);
  app.route('/api/uploads', uploadRoutes);
  // Always mounted; the account rules inside it record their changes in the
  // activity feed when it was handed over.
  app.route('/api/runtimes', createRuntimesRoutes({ activity: deps.activity }));
  // The person's own tunnel, managed remote access and the DorkOS account:
  // the Owner-only front-door settings, behind the same chain as every route.
  app.route('/api/tunnel', tunnelRoutes);
  app.route('/api/remote-access', createRemoteAccessRoutes());
  app.route('/api/lan-access', createLanAccessRoutes());
  app.route('/api/cloud', cloudRoutes);
  app.route('/api/config', configRoutes);
  app.route('/api/mcp-config', mcpConfigRoutes);
  app.route(
    '/api/onboarding',
    createOnboardingRoutes(
      productionOnboardingDeps(() => deps.onboarding?.meshCore() ?? deps.mesh?.meshCore)
    )
  );
  app.route('/api/feedback', feedbackRoutes);
  app.route(
    '/api/canvas/docs',
    createCanvasDocEventRoutes(() => deps.docChannel)
  );
  // Diagnostic reads. ALWAYS mounted and read-only: an env gate would make them
  // unavailable in the one situation they exist for, because enabling one needs
  // a restart and a restart destroys the in-memory state you wanted to read.
  // They carry only what a span may carry, behind the chain's host guard and
  // session gate with no carve-out (`routes/debug.ts`).
  app.route(
    '/api/debug',
    createDebugRoutes(() => deps.debug)
  );
  if (deps.admin) app.route('/api/admin', createAdminRoutes(deps.admin));
  // Test-only surfaces, imported always (no vitest or SDK deps) but mounted only
  // in test mode, so none of their paths exist in production.
  if (env.DORKOS_TEST_RUNTIME || deps.testControl) {
    app.route('/api/test', createTestControlRoutes(deps.testControl));
  }
  // The mock OAuth-protected MCP server (DOR-952), at the ROOT so it can serve
  // the `/.well-known/*` discovery paths there (RFC 9728/8414), beside its
  // `/api/test/mcp-oauth/*` auth and MCP endpoints.
  if (env.DORKOS_TEST_RUNTIME) app.route('/', createMockMcpOAuthRoutes());
  if (deps.sessionLocations) {
    app.route('/api/session-locations', createSessionLocationsRoutes(deps.sessionLocations));
  }
  if (deps.templates) app.route('/api/templates', createTemplateRoutes(deps.templates.dorkHome));
  if (deps.harness) app.route('/api/harness', createHarnessRoutes(deps.harness));
  if (deps.shapes) app.route('/api/shapes', createShapesRoutes(deps.shapes));
  if (deps.marketplace) {
    app.route('/api/marketplace', createMarketplaceRoutes(deps.marketplace));
  }
  if (deps.team) app.route('/api/team', createTeamRoutes(deps.team));
  if (deps.profile) app.route('/api/profile', createProfileRouter(deps.profile));
  if (deps.search) app.route('/api/search', createSearchRoutes(deps.search));
  if (deps.activity) app.route('/api/activity', createActivityRoutes(deps.activity));
  if (deps.audit) app.route('/api/audit', createAuditRoutes(deps.audit));
  if (deps.tasks) app.route('/api/tasks', createTasksRoutes(deps.tasks));
  if (deps.connectors) app.route('/api/connectors', createConnectorRoutes(deps.connectors));
  if (deps.notifications) {
    app.route('/api/notifications', createNotificationsRoutes(deps.notifications));
  }
  if (deps.push) app.route('/api/push', createPushRoutes(deps.push));
  if (deps.approvals) {
    const { service, options } = deps.approvals;
    app.route('/api/approvals', createApprovalsRoutes(service, options));
  }
  if (deps.extensionDecisions) {
    app.route('/api/extension-decisions', createExtensionDecisionsRoutes(deps.extensionDecisions));
  }
  if (deps.extensions) {
    app.route(
      '/api/extensions',
      createExtensionsRoutes({ ...deps.extensions, activity: deps.activity })
    );
    app.route('/api/ext', createExtensionApiRoutes(deps.extensions.manager));
  }
  // These two are mounted on all of `/api`, because their paths span several
  // prefixes. Their groups register only their own concrete paths, so mounting them at `/api` claims
  // nothing else: every other path still reaches its group or the `/api` 404.
  if (deps.permissions) app.route('/api', createPermissionsRoutes(deps.permissions));
  if (deps.agentPause) app.route('/api', createAgentPauseRoutes(deps.agentPause));
  if (deps.mesh) app.route('/api/mesh', createMeshRoutes(deps.mesh));
  if (deps.discovery) app.route('/api/discovery', createDiscoveryRoutes(deps.discovery));
  // Six groups answer under `/api/agents`: the two above, and these four.
  // Each registers only its own concrete paths, and no two share one: the
  // agents group's paths are all fixed words (`/current`, `/resolve`,
  // `/create`), never an `:id`, so no order between them changes an answer.
  if (deps.mcpOAuth) app.route('/api/agents/mcp-oauth', createMcpOAuthRoutes(deps.mcpOAuth));
  // What the app's `/signed-in` page reads after any sign-in's callback.
  app.route('/api/sign-in-landings', createSignInLandingRoutes());
  if (deps.commitments) {
    app.route('/api/commitments', createCommitmentsRoutes(deps.commitments));
    app.route('/api/agents/:id/commitments', createAgentCommitmentsRoutes(deps.commitments));
  }
  if (deps.heartbeat) {
    app.route('/api/agents/:id/heartbeat', createHeartbeatRoutes(deps.heartbeat));
  }
  if (deps.agents) app.route('/api/agents', createAgentsRoutes(deps.agents));
  // Three groups share this prefix. The catalog is one segment deeper than the
  // matrix's `/`, and is mounted first so nothing shorter can claim it.
  if (deps.capabilities) {
    app.route('/api/capabilities/catalog', createCapabilitiesCatalogRoutes(deps.capabilities));
  }
  app.route('/api/capabilities', capabilitiesRoutes);
  if (deps.capabilities) {
    app.route('/api/capabilities', createCapabilitiesInvokeRoutes(deps.capabilities));
  }
  app.route('/api', createApiDocsRoutes());
  if (deps.relay) {
    app.route('/api/relay', createRelayRoutes(deps.relay));
    // Its own paths only, none of which the Relay routes register.
    if (deps.unclaimedChats) {
      app.route('/api/relay/unclaimed-chats', createUnclaimedChatsRoutes(deps.unclaimedChats));
    }
  }
  // A hub's owner chatting with their linked computers; the `/api` 404 elsewhere.
  app.route('/api/hub/computers', createHubComputerRoutes());
  // A computer redeeming its owner's link code; the `/api` 404 elsewhere.
  app.route('/api/hub/link', createHubLinkRoutes());
  // This computer's own switch for chatting from the web; the `/api` 404 on a hub.
  app.route('/api/session-relay', createSessionRelayRoutes());
  // The docs in one space, for wiki links; the `/api` 404 while Docs is off.
  app.route('/api/documents', createDocLinkRoutes());
  if (deps.heartbeatTriage) {
    app.route('/api/heartbeats/triage-credits', createHeartbeatTriageRoutes(deps.heartbeatTriage));
  }
  if (deps.terminal) app.route('/api/terminal', createTerminalRoutes(deps.terminal));
  if (deps.localBrowser)
    app.route('/api/local-browser', createLocalBrowserRoutes(deps.localBrowser));
  mountComputerRoutes(app, deps.computers, deps.mesh?.meshCore);
  if (deps.mcp) app.route('/mcp', createMcpRoutes(deps.mcp));
  // Its routes carry their whole paths, two of them outside `/a2a`.
  if (deps.a2a) app.route('/', createA2aRoutes(deps.a2a));
  return app;
}

/**
 * The server's routing, as `index.ts` serves it: every route group, the client
 * build in production (`CLIENT_DIST_PATH`, or the client package's own build),
 * and the route census on a test server.
 *
 * Build it after `initAuth`, as `index.ts` does, or it has no auth routes.
 *
 * @param admission - The main listener's shared terminal state.
 * @param deps - What the route groups read; see {@link HonoApiDeps}.
 * @returns The app, for `createFrontDoorServer` or `frontDoorListener`.
 */
export function composeFrontDoor(
  admission: MainRequestAdmission,
  deps?: HonoApiDeps
): Hono<ApiEnv> {
  const app = createHonoApi({ admission, deps, clientDist: clientDistPath() });
  if (env.DORKOS_TEST_RUNTIME) serveRouteCensus(app);
  return app;
}
