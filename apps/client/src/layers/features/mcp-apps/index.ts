/**
 * MCP Apps (SEP-1865) host feature — renders interactive `ui://` HTML Apps
 * shipped by MCP servers, inline in chat and in the canvas, behind a sandboxed
 * postMessage bridge (spec `mcp-apps-host`; Tier 2 of the generative-UI program).
 *
 * @module features/mcp-apps
 */
export { McpAppBlock, type McpAppBlockProps } from './ui/McpAppBlock';
export { McpAppFrame, type McpAppFrameProps } from './ui/McpAppFrame';
export { useMcpAppResource } from './model/use-mcp-app-resource';
export { useRenderConsent, hasRenderConsent, grantRenderConsent } from './model/render-consent';
