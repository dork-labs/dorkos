/**
 * MCP tool server — composition root that assembles domain-specific tools
 * into a single SDK MCP server instance.
 *
 * @module services/runtimes/claude-code/mcp-tools
 */
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { McpToolDeps } from './types.js';
import { DORKOS_MCP_SERVER_NAME } from './tool-names.js';
import { getCoreTools } from './core-tools.js';
import { getTasksTools } from './task-tools.js';
import { getRelayTools } from './relay-tools.js';
import { resolveSenderIdentity } from './relay-helpers.js';
import { getAdapterTools } from './adapter-tools.js';
import { getBindingTools } from './binding-tools.js';
import { getTraceTools } from './trace-tools.js';
import { getMeshTools } from './mesh-tools.js';
import { getAgentTools } from './agent-tools.js';
import { getUiTools } from './ui-tools.js';
import { getDevtoolsTools } from './devtools-tools.js';
import { getExtensionTools } from './extension-tools.js';
import { capabilityMcpTools } from './capability-mcp-tools.js';
import { createInSessionContextResolver } from '../../../core/agent-identity/index.js';
import type { AgentIdentity } from '../../../core/agent-identity/index.js';
import { gateHandRegisteredMcpTools, type SdkMcpTool } from '../../../core/mcp-tool-gate.js';
import type { MarketplaceMcpDeps } from '../../../marketplace-mcp/marketplace-mcp-tools.js';
import type { CapabilityRegistry } from '../../../core/capabilities/index.js';
import { composeDorkOsCapabilityRegistry } from '../../../core/self-description/dorkos-registry.js';
import { registerDorkOsResources } from '../../../core/mcp-resources/index.js';
import { logger } from '../../../../lib/logger.js';

// Re-export the individual handlers and handler factories, which the per-domain
// tests import by name to exercise one handler without standing up a server.
//
// They used to also serve the external `/mcp` registration files. Those now import
// each domain's DEFINITIONS (name + description + input schema + handler together)
// straight from the domain module instead, so the tool is described once for both
// servers (DOR-499). Production reaches this barrel only for
// `createDorkOsToolServer`, from `apps/server/src/index.ts`.
export type { McpToolDeps } from './types.js';
export {
  handlePing,
  handleGetServerInfo,
  createGetSessionCountHandler,
  createGetAgentHandler,
  resolveAgentCwd,
} from './core-tools.js';
export {
  createListSchedulesHandler,
  createCreateScheduleHandler,
  createUpdateScheduleHandler,
  createDeleteScheduleHandler,
  createGetRunHistoryHandler,
} from './task-tools.js';
export {
  createRelaySendHandler,
  createRelayInboxHandler,
  createRelayListEndpointsHandler,
  createRelayRegisterEndpointHandler,
  createRelayQueryHandler,
  createRelayDispatchHandler,
  createRelayUnregisterEndpointHandler,
} from './relay-tools.js';
export { createRelayNotifyUserHandler } from './relay-notify-tools.js';
export {
  createRelayListAdaptersHandler,
  createRelayEnableAdapterHandler,
  createRelayDisableAdapterHandler,
  createRelayReloadAdaptersHandler,
} from './adapter-tools.js';
export {
  createBindingListHandler,
  createBindingCreateHandler,
  createBindingDeleteHandler,
  createBindingListSessionsHandler,
} from './binding-tools.js';
export { createRelayGetTraceHandler, createRelayGetMetricsHandler } from './trace-tools.js';
export { createCreateAgentHandler } from './agent-tools.js';
export {
  createMeshDiscoverHandler,
  createMeshRegisterHandler,
  createMeshListHandler,
  createMeshDenyHandler,
  createMeshUnregisterHandler,
  createMeshStatusHandler,
  createMeshInspectHandler,
  createMeshQueryTopologyHandler,
} from './mesh-tools.js';
export { createControlUiHandler, createGetUiStateHandler, type UiToolSession } from './ui-tools.js';
export {
  createReadConsoleHandler,
  createReadNetworkHandler,
  createBrowserScreenshotHandler,
  getDevtoolsTools,
  type DevtoolsReadStore,
  type DevtoolsSessionResolver,
  type DevtoolsEventSession,
} from './devtools-tools.js';
export {
  createListExtensionsHandler,
  createGetExtensionErrorsHandler,
  createGetExtensionApiHandler,
  createCreateExtensionHandler,
  createReloadExtensionsHandler,
  createTestExtensionHandler,
} from './extension-tools.js';
/**
 * Every hand-registered in-session tool, behind the tier gate.
 *
 * This is the whole hand-registered surface in one place, and the tier gate wraps
 * all of it (DOR-468): the wrap resolves each tool's tier eagerly, so a tool added
 * without one throws here rather than running ungated. The registry-generated tools
 * are deliberately NOT in this list — `registry.invoke` gates those from the
 * inside, and wrapping them twice would ask a person to approve one action twice.
 *
 * Exported so the gate's tests drive the SAME list the server builds. A test that
 * restated the domains would go green while a real domain quietly stopped being
 * gated, which is the exact failure this whole feature exists to stop.
 *
 * @param deps - Shared tool dependencies (relay, tasks, mesh, etc.).
 * @param options - Per-query session context; every field is absent on the
 *   introspection and unit-test paths, which then gate as an unidentified caller.
 * @returns The gated tool definitions.
 * @throws If any tool declares no tier in `MCP_TOOL_TIERS`.
 */
export function handRegisteredInSessionTools(
  deps: McpToolDeps,
  options: {
    /** Per-query session for UI tool event emission and state access. */
    session?: import('./ui-tools.js').UiToolSession;
    /** Per-query trigger session id (DevTools read fallback). */
    sessionId?: string;
    /** Resolves the calling agent for this session; see `mcp-tool-gate.ts`. */
    resolveContext?: () => Promise<{ identity?: AgentIdentity } | undefined>;
  } = {}
): SdkMcpTool[] {
  const { session, sessionId, resolveContext } = options;
  // Resolve the caller's trusted Relay identity from the session's working
  // directory (its agent manifest), not from tool arguments — this is what
  // relay `from`/namespace access rules key on.
  const relayIdentity = resolveSenderIdentity(deps, session?.cwd);
  // Read-time id resolution for the DevTools tools: prefer the live session's
  // sdkSessionId (updated to the canonical id by the SDK init mid-first-turn,
  // tracking the store's rekeySession) over the static trigger id. Absent both
  // (external MCP surface / introspection stub), register the session-less
  // error variants.
  const resolveDevtoolsSessionId =
    session || sessionId ? () => session?.sdkSessionId || sessionId || undefined : undefined;

  return gateHandRegisteredMcpTools(
    [
      ...getCoreTools(deps),
      ...getTasksTools(deps),
      ...getRelayTools(deps, relayIdentity),
      ...getAdapterTools(deps),
      ...getBindingTools(deps),
      ...getTraceTools(deps),
      ...getMeshTools(deps),
      ...getAgentTools(deps),
      ...getUiTools(deps, session),
      ...getDevtoolsTools(deps, resolveDevtoolsSessionId, undefined, session),
      ...getExtensionTools(deps),
    ],
    resolveContext
  );
}

/**
 * Create the DorkOS MCP tool server with all registered tools.
 *
 * Called per SDK query (via `mcpServerFactory`) so each query gets a fresh
 * MCP server instance. When `session` is provided, UI tools emit real SSE
 * events and read actual state; without it, they use stubs (external MCP only).
 * The DevTools tools resolve their capture-buffer key at READ time — the
 * live session's `sdkSessionId`, falling back to the trigger `sessionId` —
 * because the first-turn canonical rekey moves the buffer mid-turn; without a
 * session or id those tools return a session-less error. `browser_screenshot`
 * additionally rides the session's event queue (the `ui_command` seam) to
 * reach the attached client with its capture request.
 *
 * The operator, marketplace, and self-description tools are generated from the
 * Capability Registry via {@link capabilityMcpTools}: the shared boot-composed
 * `registry` when passed, or one composed on the spot from `deps` +
 * `marketplaceDeps` when omitted (unit tests). The marketplace capabilities join
 * the registry only when `marketplaceDeps` is present — resolved lazily at the
 * `index.ts` call site (the per-query factory closure reads a binding populated
 * later in boot), so a relay-disabled instance simply omits those tools.
 *
 * The read-only `dorkos://` resources (sessions, agents, skills, capabilities)
 * are registered through the shared {@link registerDorkOsResources}, so this
 * server answers "what is the state of my world?" with the same four resources the
 * external `/mcp` server exposes. Session and skill reads are scoped to the
 * session's own working directory here, not the server's default project.
 *
 * @param deps - Shared tool dependencies (relay, tasks, mesh, etc.)
 * @param session - Per-query session for UI tool event emission and state access
 * @param sessionId - Per-query trigger session id (DevTools read fallback)
 * @param marketplaceDeps - Marketplace dependency bundle, or `undefined` when
 *   the marketplace surface is unavailable (relay disabled / not yet wired)
 * @param registry - The shared boot-composed capability registry. When omitted,
 *   one is composed on the spot from `deps` + `marketplaceDeps`.
 */
export function createDorkOsToolServer(
  deps: McpToolDeps,
  session?: import('./ui-tools.js').UiToolSession,
  sessionId?: string,
  marketplaceDeps?: MarketplaceMcpDeps,
  registry?: CapabilityRegistry
) {
  // Operator + marketplace + self-description tools, all generated from the
  // Capability Registry (shared boot instance, or composed on the spot).
  const capabilityRegistry =
    registry ??
    composeDorkOsCapabilityRegistry({
      logger,
      operatorDeps: deps,
      ...(marketplaceDeps && { marketplaceDeps }),
    });
  // One resolver for both halves of the tool surface, so the session's identity is
  // looked up once and the two paths cannot disagree about who is calling.
  const resolveContext = createInSessionContextResolver(session?.cwd);
  // Registry capabilities additionally learn WHICH session is calling, read per
  // tool call (the live session's canonical `sdkSessionId` over the trigger id,
  // mirroring the DevTools read-time resolution) so session-scoped capabilities
  // — connector attach/detach — can default to the invoking session.
  // …and WHERE that session lives, so a capability whose work outlives the
  // process (a sign-in the person finishes in a browser) can be resumed in the
  // right directory after a restart (DOR-981).
  const resolveCapabilityContext = async () => {
    const base = await resolveContext();
    const invokingSessionId = session?.sdkSessionId || sessionId;
    if (!invokingSessionId) return base;
    return {
      ...(base ?? {}),
      sessionId: invokingSessionId,
      ...(session?.cwd ? { cwd: session.cwd } : {}),
    };
  };
  // The in-session hold seam (DOR-939): only with BOTH a live session (an event
  // queue to render the inline card into) and the approval primitive can a fresh
  // destructive call hold inline and resume. Absent either — the introspection
  // stub, a hermetic test — capabilities keep the token/poll flow untouched.
  const hold = session && deps.approvals ? { session, approvals: deps.approvals } : undefined;
  const server = createSdkMcpServer({
    // Not a label: Claude Code qualifies every tool on this server as
    // `mcp__<name>__<tool>`, so this string is half of what the model must type
    // to call anything here. `tool-names.ts` owns it and the prompt blocks render
    // from the same constant (DOR-1292).
    name: DORKOS_MCP_SERVER_NAME,
    version: '1.0.0',
    tools: [
      ...handRegisteredInSessionTools(deps, {
        ...(session ? { session } : {}),
        ...(sessionId ? { sessionId } : {}),
        resolveContext,
      }),
      ...capabilityMcpTools(capabilityRegistry, 'in-session', resolveCapabilityContext, hold),
    ],
  });

  // The read-only `dorkos://` resources: the same registration the external
  // `/mcp` server performs, scoped to THIS session's project rather than the
  // server's default. `createSdkMcpServer` hands back a real `McpServer` that it
  // has not connected yet, so resources can be registered on it here.
  registerDorkOsResources(
    server.instance,
    deps,
    capabilityRegistry,
    session?.cwd ?? deps.defaultCwd
  );

  return server;
}
