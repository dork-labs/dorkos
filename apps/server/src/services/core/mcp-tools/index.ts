/**
 * MCP tool server — composition root that assembles domain-specific tools
 * into a single SDK MCP server instance.
 *
 * @module services/core/mcp-tools
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

// Re-export types and handlers for external consumers
export type { McpToolDeps } from './types.js';
export { handlePing, handleGetServerInfo, createGetSessionCountHandler, createGetCurrentAgentHandler } from './core-tools.js';
export { createListSchedulesHandler, createCreateScheduleHandler, createUpdateScheduleHandler, createDeleteScheduleHandler, createGetRunHistoryHandler } from './pulse-tools.js';
export { createRelaySendHandler, createRelayInboxHandler, createRelayListEndpointsHandler, createRelayRegisterEndpointHandler, createRelayDispatchHandler, createRelayUnregisterEndpointHandler } from './relay-tools.js';
export { createRelayListAdaptersHandler, createRelayEnableAdapterHandler, createRelayDisableAdapterHandler, createRelayReloadAdaptersHandler } from './adapter-tools.js';
export { createBindingListHandler, createBindingCreateHandler, createBindingDeleteHandler } from './binding-tools.js';
export { createRelayGetTraceHandler, createRelayGetMetricsHandler } from './trace-tools.js';
export { createMeshDiscoverHandler, createMeshRegisterHandler, createMeshListHandler, createMeshDenyHandler, createMeshUnregisterHandler, createMeshStatusHandler, createMeshInspectHandler, createMeshQueryTopologyHandler } from './mesh-tools.js';

/**
 * Create the DorkOS MCP tool server with all registered tools.
 * Called once at server startup. The returned server instance is injected
 * into AgentManager and passed to every SDK query() call.
 */
export function createDorkOsToolServer(deps: McpToolDeps) {
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
    ],
  });
}
