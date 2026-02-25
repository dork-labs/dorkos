/**
 * Core services — agent orchestration, context building, configuration,
 * SSE streaming, MCP tools, and infrastructure utilities.
 *
 * @module services/core
 */
export { AgentManager, agentManager } from './agent-manager.js';
export type { AgentSession, ToolState } from './agent-types.js';
export { createToolState } from './agent-types.js';
export { buildSystemPromptAppend } from './context-builder.js';
export { mapSdkMessage } from './sdk-event-mapper.js';
export { CommandRegistryService } from './command-registry.js';
export { configManager, initConfigManager } from './config-manager.js';
export { fileLister } from './file-lister.js';
export { getGitStatus, parsePorcelainOutput } from './git-status.js';
export {
  handleAskUserQuestion,
  createCanUseTool,
  handleToolApproval,
} from './interactive-handlers.js';
export type { PendingInteraction, InteractiveSession } from './interactive-handlers.js';
export {
  handlePing,
  handleGetServerInfo,
  createGetSessionCountHandler,
  createListSchedulesHandler,
  createCreateScheduleHandler,
  createUpdateScheduleHandler,
  createDeleteScheduleHandler,
  createGetRunHistoryHandler,
  createRelaySendHandler,
  createRelayInboxHandler,
  createRelayListEndpointsHandler,
  createRelayRegisterEndpointHandler,
  createDorkOsToolServer,
} from './mcp-tool-server.js';
export type { McpToolDeps } from './mcp-tool-server.js';
export { generateOpenAPISpec } from './openapi-registry.js';
export { initSSEStream, sendSSEEvent, endSSEStream } from './stream-adapter.js';
export { TunnelManager, tunnelManager } from './tunnel-manager.js';
export type { TunnelConfig, TunnelStatus } from './tunnel-manager.js';
export { getLatestVersion, resetCache } from './update-checker.js';
