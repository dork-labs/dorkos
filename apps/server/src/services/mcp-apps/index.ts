/**
 * MCP Apps (SEP-1865) server domain — the DorkOS-owned resource fetch that lets
 * the client render `ui://` App resources shipped by MCP servers (ADR
 * `260708-141143`; spec `mcp-apps-host`).
 *
 * @module services/mcp-apps
 */
export {
  resolveAppResource,
  McpAppResourceError,
  UI_SCHEME,
  __clearMcpAppResourceCache,
  type McpAppResourceErrorCode,
} from './mcp-app-resource-service.js';
