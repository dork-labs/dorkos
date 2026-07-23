/**
 * Register registry capabilities as tools on the external `/mcp` `McpServer`
 * (spec `capability-registry`, task 2.2).
 *
 * This is the `@modelcontextprotocol/sdk`-specific half of the MCP projection —
 * a thin walk over {@link capabilitiesForMcpServer} that replaces the former
 * hand-written descriptor loops (`registerOperatorTools`,
 * `registerMarketplaceTools`). All the transport-neutral work (server
 * selection, input-shape recovery, annotation derivation, invoke + envelope
 * re-wrap) lives in `core/capabilities/mcp-projection.ts`; this module only maps
 * it onto `server.registerTool()`.
 *
 * @module services/core/external-mcp/capability-mcp-tools
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServerId } from '@dorkos/shared/capabilities';

import type { CapabilityRegistry } from '../capabilities/index.js';
import {
  capabilitiesForMcpServer,
  capabilityInputShape,
  deriveMcpAnnotations,
  invokeCapabilityAsMcpResult,
} from '../capabilities/mcp-projection.js';

/**
 * Register every registry capability advertised on the given MCP server against
 * an existing external `McpServer` instance.
 *
 * Each tool's `annotations` (read/write/destructive/open-world hints) are
 * derived from the capability's tier + per-tool overrides, its input schema is
 * recovered as the SDK's field-map shape, and its handler runs the capability
 * through the registry and re-wraps the plain result into the MCP envelope.
 *
 * @param server - The external `McpServer` instance to register tools against.
 * @param registry - The composed capability registry.
 * @param transport - Which server's tool surface to project (defaults to
 *   `external`).
 */
export function registerCapabilitiesAsMcpTools(
  server: McpServer,
  registry: CapabilityRegistry,
  transport: McpServerId = 'external'
): void {
  for (const capability of capabilitiesForMcpServer(registry, transport)) {
    const mcp = capability.surfaces.mcp;
    if (!mcp) continue;
    server.registerTool(
      mcp.toolName,
      {
        description: capability.description,
        inputSchema: capabilityInputShape(capability),
        annotations: deriveMcpAnnotations(capability),
      },
      async (args: Record<string, unknown>) =>
        invokeCapabilityAsMcpResult(registry, capability.id, args)
    );
  }
}
