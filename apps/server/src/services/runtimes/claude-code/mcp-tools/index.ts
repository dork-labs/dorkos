/**
 * MCP tool server — composition root that assembles domain-specific tools
 * into a single SDK MCP server instance.
 *
 * @module services/runtimes/claude-code/mcp-tools
 */
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { McpToolDeps } from './types.js';
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

// Re-export types and handlers for external consumers
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
  createRelayNotifyUserHandler,
} from './relay-tools.js';
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
 * @param deps - Shared tool dependencies (relay, tasks, mesh, etc.)
 * @param session - Per-query session for UI tool event emission and state access
 * @param sessionId - Per-query trigger session id (DevTools read fallback)
 */
export function createDorkOsToolServer(
  deps: McpToolDeps,
  session?: import('./ui-tools.js').UiToolSession,
  sessionId?: string
) {
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
  return createSdkMcpServer({
    name: 'dorkos',
    version: '1.0.0',
    tools: [
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
  });
}
