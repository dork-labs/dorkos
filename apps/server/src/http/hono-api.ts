/**
 * The Hono half of the server: the `/api` chain with every route group that
 * has moved off Express mounted on it (`plans/2026-10-express-to-hono.md`).
 *
 * {@link composeFrontDoor} hands it to the front door, which claims its routes
 * ahead of the Express fallthrough (`http/front-door.ts`). `index.ts` serves
 * that, and tests that need the server's real routing build the same thing.
 * Each move PR mounts its group here and deletes the group's Express router in
 * the same change.
 *
 * @module http/hono-api
 */
import type { RequestListener } from 'node:http';
import type { Hono } from 'hono';
import { env } from '../env.js';
import { getAuth } from '../services/core/auth/index.js';
import type { MainRequestAdmission } from '../services/core/lifecycle/main-request-admission.js';
import { createApiApp, type ApiEnv } from './api-chain.js';
import { mountBetterAuth } from './better-auth.js';
import { createFrontDoor, type FrontDoor } from './front-door.js';
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
import configRoutes from '../routes/config.js';
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
import {
  createExtensionDecisionsRoutes,
  type ExtensionDecisionsRouterDeps,
} from '../routes/extension-decisions.js';
import feedbackRoutes, { feedbackBodyRule } from '../routes/feedback.js';
import fileRoutes from '../routes/files.js';
import gitRoutes from '../routes/git.js';
import { createHarnessRoutes, type HarnessRouterDeps } from '../routes/harness.js';
import { createHealthRoutes, type HealthRouteDeps } from '../routes/health.js';
import keepAwakeRoutes from '../routes/keep-awake.js';
import { createMarketplaceRoutes, type MarketplaceRouteDeps } from '../routes/marketplace.js';
import { createMcpRoutes, type McpServerFactory } from '../routes/mcp.js';
import mcpConfigRoutes from '../routes/mcp-config.js';
import { createMcpOAuthRoutes } from '../routes/mcp-oauth.js';
import { createMeshRoutes, type MeshRouterDeps } from '../routes/mesh.js';
import { createMockMcpOAuthRoutes } from '../routes/mock-mcp-oauth-server.js';
import modelRoutes from '../routes/models.js';
import { createNotificationsRoutes } from '../routes/notifications.js';
import { createPermissionsRoutes, type PermissionsRouterDeps } from '../routes/permissions.js';
import { createProfileRouter, type ProfileRouterDeps } from '../routes/profile.js';
import projectRoutes from '../routes/projects.js';
import { createRuntimesRoutes } from '../routes/runtimes.js';
import { createPushRoutes, type PushRouterDeps } from '../routes/push.js';
import { createRelayRoutes, type RelayRouteDeps } from '../routes/relay.js';
import { relayWebhookBodyRule } from '../routes/relay-webhooks.js';
import readCursorRoutes from '../routes/read-cursors.js';
import { createRemoteAccessRoutes } from '../routes/remote-access.js';
import { createSearchRoutes, type SearchRouterDeps } from '../routes/search.js';
import { createSessionLocationsRoutes } from '../routes/session-locations.js';
import { createShapesRoutes, type ShapesRouterDeps } from '../routes/shapes.js';
import subagentRoutes from '../routes/subagents.js';
import { createTasksRoutes, type TasksRouterDeps } from '../routes/tasks.js';
import { createSystemRoutes, type SystemRouteDeps } from '../routes/system.js';
import { createTeamRoutes, type TeamRouterDeps } from '../routes/team.js';
import { createTemplateRoutes } from '../routes/templates.js';
import {
  createUnclaimedChatsRoutes,
  type UnclaimedChatsRouterDeps,
} from '../routes/unclaimed-chats.js';
import { createTestControlRoutes, type TestControlDeps } from '../routes/test-control.js';
import tunnelRoutes from '../routes/tunnel.js';
import uploadRoutes from '../routes/uploads.js';
import workbenchServeRoutes from '../routes/workbench-serve.js';
import workspaceRoutes from '../routes/workspaces.js';

/**
 * The groups that are only mounted when the server hands over what they read.
 * A test that builds the server bare passes none of them, and those paths then
 * answer the `/api` 404, as they did when `index.ts` mounted them on Express.
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
  /** What agents may do (`/api/permissions*`, `/api/agents/:id/permissions`). */
  permissions?: PermissionsRouterDeps;
  /** Pausing an agent everywhere (`/api/agents/pauses`, `/api/agents/:id/{pause,resume}`). */
  agentPause?: AgentPauseRouterDeps;
  /** The operator's photo and name (`/api/profile`). */
  profile?: ProfileRouterDeps;
  /** The agent registry's routes (`/api/mesh`). Only handed over when the mesh started. */
  mesh?: MeshRouterDeps;
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
  docChannel?: DocChannelHttp;
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
export type HonoApiDeps = HealthRouteDeps & SystemRouteDeps & ComposedGroupDeps;

/** Options for {@link createHonoApi}. */
export interface HonoApiOptions {
  /** The main listener's shared terminal state. */
  admission: MainRequestAdmission;
  /** See {@link HonoApiDeps}. A test that builds the server bare passes none. */
  deps?: HonoApiDeps;
}

/**
 * Build the Hono `/api` app with every moved group mounted.
 *
 * Better Auth is mounted whenever `initAuth` has run, even with login off, so
 * the enable-login flow can create the owner account before the flag flips. A
 * unit test that builds the server without auth gets no auth routes.
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
    bodyRules: [feedbackBodyRule, docEventBodyRule, relayWebhookBodyRule],
    beforeBodyParsing: (early) => {
      if (auth) mountBetterAuth(early, { auth, maxAttempts: env.DORKOS_AUTH_SIGNIN_RATE_LIMIT });
      if (deps.connectorEventIngress) {
        mountConnectorSignedIngress(early, deps.connectorEventIngress);
      }
    },
  });
  app.route('/api/health', createHealthRoutes(deps));
  app.route('/api/models', modelRoutes);
  app.route('/api/commands', commandRoutes);
  app.route('/api/subagents', subagentRoutes);
  app.route('/api/system', createSystemRoutes(deps));
  app.route('/api/keep-awake', keepAwakeRoutes);
  app.route('/api/errors', errorRoutes);
  app.route('/api/directory', directoryRoutes);
  app.route('/api/git', gitRoutes);
  app.route('/api/workspaces', workspaceRoutes);
  app.route('/api/projects', projectRoutes);
  app.route('/api/read-cursors', readCursorRoutes);
  app.route('/api/files', fileRoutes);
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
  app.route('/api/cloud', cloudRoutes);
  app.route('/api/config', configRoutes);
  app.route('/api/mcp-config', mcpConfigRoutes);
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
  // These two were Express routers mounted on all of `/api`. Their groups
  // register only their own concrete paths, so mounting them at `/api` claims
  // nothing else: every other path still reaches its group or the `/api` 404.
  if (deps.permissions) app.route('/api', createPermissionsRoutes(deps.permissions));
  if (deps.agentPause) app.route('/api', createAgentPauseRoutes(deps.agentPause));
  if (deps.mesh) app.route('/api/mesh', createMeshRoutes(deps.mesh));
  if (deps.discovery) app.route('/api/discovery', createDiscoveryRoutes(deps.discovery));
  // Five groups answer under `/api/agents`: the two above, and these three.
  // Each registers only its own concrete paths, and no two share one: the
  // agents group's paths are all fixed words (`/current`, `/resolve`,
  // `/create`), never an `:id`, so no order between them changes an answer.
  if (deps.mcpOAuth) app.route('/api/agents/mcp-oauth', createMcpOAuthRoutes(deps.mcpOAuth));
  if (deps.commitments) {
    app.route('/api/commitments', createCommitmentsRoutes(deps.commitments));
    app.route('/api/agents/:id/commitments', createAgentCommitmentsRoutes(deps.commitments));
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
  if (deps.mcp) app.route('/mcp', createMcpRoutes(deps.mcp));
  // Its routes carry their whole paths, two of them outside `/a2a`.
  if (deps.a2a) app.route('/', createA2aRoutes(deps.a2a));
  return app;
}

/**
 * The server's routing: the front door, with the Hono `/api` app claiming its
 * routes and `legacy` answering the rest. A test server also serves the route
 * census.
 *
 * Build it after `initAuth`, as `index.ts` does, or the Hono app has no auth
 * routes.
 *
 * @param legacy - The Express app from `createApp`.
 * @param admission - The main listener's shared terminal state.
 * @param deps - What the moved groups read; see {@link HonoApiDeps}.
 * @returns The front door, for `createFrontDoorServer` or `frontDoorListener`.
 */
export function composeFrontDoor(
  legacy: RequestListener,
  admission: MainRequestAdmission,
  deps?: HonoApiDeps
): FrontDoor {
  return createFrontDoor(legacy, {
    api: createHonoApi({ admission, deps }),
    census: env.DORKOS_TEST_RUNTIME,
  });
}
