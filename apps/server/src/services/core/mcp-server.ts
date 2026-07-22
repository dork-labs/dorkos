import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolDeps } from '../runtimes/claude-code/mcp-tools/types.js';
import { resolveSenderIdentity } from '../runtimes/claude-code/mcp-tools/relay-helpers.js';
import { registerCoreTools } from './external-mcp/core-tools.js';
import { registerTaskTools } from './external-mcp/task-tools.js';
import { registerRelayTools } from './external-mcp/relay-tools.js';
import { registerBindingTools } from './external-mcp/binding-tools.js';
import { registerMeshTools } from './external-mcp/mesh-tools.js';
import { registerAgentAndExtensionTools } from './external-mcp/agent-extension-tools.js';
import { registerOperatorTools } from './external-mcp/operator-tools.js';
import { registerSessionResources } from './external-mcp/session-resources.js';
import { registerAgentResources } from './external-mcp/agent-resources.js';
import { registerSkillResources } from './external-mcp/skill-resources.js';
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
 * Read-only `dorkos://` resources (sessions, agents, skills —
 * `external-mcp/*-resources.ts`) are registered alongside the tools. This
 * server is **stateless per request** (ADR: a fresh `McpServer` is
 * constructed for every `/mcp` call — see the router in `index.ts`), so it
 * can never emit a `notifications/resources/list_changed` push after the
 * response it was created for. The MCP SDK's high-level `registerResource()`
 * unconditionally advertises `resources.listChanged: true` the moment any
 * resource is registered (no public opt-out); the explicit
 * `registerCapabilities` call below corrects that to `false` immediately
 * after registration so the `initialize` response doesn't promise a push
 * channel this transport can't deliver. Resource *subscriptions*
 * (`resources/subscribe`) are never wired up at all — the high-level SDK has
 * no subscription API — so that capability is never advertised in the first
 * place; nothing to override there.
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
  registerOperatorTools(server, deps);

  // ── Marketplace tools (conditional on marketplace deps being available) ─
  if (marketplaceDeps) {
    registerMarketplaceTools(server, marketplaceDeps);
  }

  // ── Read-only resources ──────────────────────────────────────────────────
  registerSessionResources(server, deps);
  registerAgentResources(server, deps);
  registerSkillResources(server, deps);

  // Correct the SDK's auto-advertised `listChanged: true` — see the module
  // TSDoc above. Must run after registration (which is what sets it) and
  // before `connect()` (capabilities are immutable once connected).
  server.server.registerCapabilities({ resources: { listChanged: false } });

  return server;
}
