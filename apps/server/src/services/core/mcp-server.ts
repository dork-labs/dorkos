import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolDeps } from '../runtimes/claude-code/mcp-tools/types.js';
import { resolveSenderIdentity } from '../runtimes/claude-code/mcp-tools/relay-helpers.js';
import { registerCoreTools } from './external-mcp/core-tools.js';
import { registerTaskTools } from './external-mcp/task-tools.js';
import { registerRelayTools } from './external-mcp/relay-tools.js';
import { registerBindingTools } from './external-mcp/binding-tools.js';
import { registerMeshTools } from './external-mcp/mesh-tools.js';
import { registerAgentAndExtensionTools } from './external-mcp/agent-extension-tools.js';
import {
  registerMarketplaceTools,
  type MarketplaceMcpDeps,
} from '../marketplace-mcp/marketplace-mcp-tools.js';
import { SERVER_ICONS } from './mcp-tool-metadata.js';

/**
 * Create the external MCP server instance with all DorkOS tools registered.
 *
 * Uses the `@modelcontextprotocol/sdk` McpServer API (Streamable HTTP transport).
 * This is the external counterpart to `createDorkOsToolServer()` which uses the
 * Claude Agent SDK for internal agent tool injection.
 *
 * All tools are always registered regardless of feature flag state. Feature-guarded
 * handlers already return descriptive errors when their service is disabled.
 *
 * Every tool is registered via `registerTool()` (not the deprecated `tool()`
 * overloads) so it carries `ToolAnnotations` (`readOnlyHint`,
 * `destructiveHint`, `idempotentHint`, `openWorldHint`) — see
 * `mcp-tool-metadata.ts` for the annotation presets and the PR description
 * for the full per-tool matrix. Registration itself is split by domain into
 * `external-mcp/*.ts` (core, tasks, relay, binding, mesh, agent+extension) so
 * this file stays a thin composer rather than a 700+ line registration
 * dispatch table. A handful of read/list tools with an exact existing Zod
 * schema also declare `outputSchema` and return matching `structuredContent`
 * (via `structuredJsonContent()` in the shared handlers).
 *
 * The marketplace MCP surface is registered conditionally — when
 * `marketplaceDeps` is supplied (the relay-enabled boot path), every
 * `marketplace_*` tool is added to the server. When `marketplaceDeps` is
 * `undefined` (e.g. relay disabled), the server still boots and the
 * marketplace branch is silently skipped.
 *
 * @param deps - Service dependencies shared with the internal tool path
 * @param marketplaceDeps - Optional marketplace dependency bundle. When
 *   provided, every marketplace tool is registered against the server.
 */
export function createExternalMcpServer(
  deps: McpToolDeps,
  marketplaceDeps?: MarketplaceMcpDeps
): McpServer {
  const server = new McpServer({
    name: 'dorkos',
    version: '1.0.0',
    icons: SERVER_ICONS,
  });

  // The external /mcp surface has no per-session context, so every relay send
  // acts as a single, server-controlled external principal — the LLM never
  // asserts its own `from`.
  const relayIdentity = resolveSenderIdentity(deps, undefined);

  registerCoreTools(server, deps);
  registerTaskTools(server, deps);
  registerRelayTools(server, deps, relayIdentity);
  registerBindingTools(server, deps);
  registerMeshTools(server, deps);
  registerAgentAndExtensionTools(server, deps);

  // ── Marketplace tools (conditional on marketplace deps being available) ─
  if (marketplaceDeps) {
    registerMarketplaceTools(server, marketplaceDeps);
  }

  return server;
}
