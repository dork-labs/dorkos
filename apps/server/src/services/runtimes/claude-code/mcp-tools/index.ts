/**
 * MCP tool server — composition root that assembles domain-specific tools
 * into a single SDK MCP server instance.
 *
 * @module services/runtimes/claude-code/mcp-tools
 */
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { McpToolDeps } from './types.js';
import { getCoreTools } from './core-tools.js';
import { getPulseTools } from './pulse-tools.js';
import { getRelayTools } from './relay-tools.js';
import { getAdapterTools } from './adapter-tools.js';
import { getBindingTools } from './binding-tools.js';
import { getTraceTools } from './trace-tools.js';
import { getMeshTools } from './mesh-tools.js';
import { getAgentTools } from './agent-tools.js';
import { getUiTools } from './ui-tools.js';

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
} from './pulse-tools.js';
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

/**
 * Create the DorkOS MCP tool server with all registered tools.
 *
 * Called per SDK query (via `mcpServerFactory`) so each query gets a fresh
 * MCP server instance. When `session` is provided, UI tools emit real SSE
 * events and read actual state; without it, they use stubs (external MCP only).
 *
 * @param deps - Shared tool dependencies (relay, pulse, mesh, etc.)
 * @param session - Per-query session for UI tool event emission and state access
 */
export function createDorkOsToolServer(
  deps: McpToolDeps,
  session?: import('./ui-tools.js').UiToolSession
) {
  return createSdkMcpServer({
    name: 'dorkos',
    version: '1.0.0',
    tools: [
      ...getCoreTools(deps),
      ...getPulseTools(deps),
      ...getRelayTools(deps),
      ...getAdapterTools(deps),
      ...getBindingTools(deps),
      ...getTraceTools(deps),
      ...getMeshTools(deps),
      ...getAgentTools(deps),
      ...getUiTools(deps, session),
    ],
  });
}
