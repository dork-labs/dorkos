/**
 * Project registry capabilities into in-session `dorkos` MCP tool definitions
 * (spec `capability-registry`, task 2.2).
 *
 * This is the Claude Agent SDK half of the MCP projection. The SDK builds its
 * server from a `tools` array passed to `createSdkMcpServer({ tools })` rather
 * than by mutating a server instance, so — unlike the external adapter's
 * `registerCapabilitiesAsMcpTools(server, registry)` — this returns the tool
 * definitions to spread into that array. The `tool()` helper carries no
 * annotations slot, so only names, descriptions, input shapes, and handlers are
 * projected; all the transport-neutral work lives in
 * `core/capabilities/mcp-projection.ts`.
 *
 * @module services/runtimes/claude-code/mcp-tools/capability-mcp-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerId } from '@dorkos/shared/capabilities';

import type { CapabilityRegistry } from '../../../core/capabilities/index.js';
import {
  capabilitiesForMcpServer,
  capabilityInputShape,
  invokeCapabilityAsMcpResult,
} from '../../../core/capabilities/mcp-projection.js';

/**
 * Build the in-session `dorkos` server tool definitions for every registry
 * capability advertised on the in-session surface.
 *
 * @param registry - The composed capability registry.
 * @param transport - Which server's tool surface to project (defaults to
 *   `in-session`).
 * @returns SDK tool definitions to spread into `createSdkMcpServer({ tools })`.
 */
export function capabilityMcpTools(
  registry: CapabilityRegistry,
  transport: McpServerId = 'in-session'
) {
  return capabilitiesForMcpServer(registry, transport).map((capability) =>
    tool(
      capability.surfaces.mcp!.toolName,
      capability.description,
      capabilityInputShape(capability),
      async (args: Record<string, unknown>) =>
        invokeCapabilityAsMcpResult(registry, capability.id, args)
    )
  );
}
