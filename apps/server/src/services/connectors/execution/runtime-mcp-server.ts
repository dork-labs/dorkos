/** Exact authenticated MCP projection for connector execution capabilities. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CapabilityRegistry } from '../../core/capabilities/index.js';
import {
  approvalTokenArgument,
  deriveMcpAnnotations,
  invokeCapabilityAsMcpResult,
} from '../../core/capabilities/mcp-projection.js';
import { SERVER_VERSION } from '../../../lib/version.js';
import type { ServerPrincipalProof } from '../principal/server-principal.js';
import { CONNECTOR_RUNTIME_CAPABILITY_IDS } from '../runtime-capability-scope.js';

function abortSignalOf(extra: unknown): AbortSignal | undefined {
  if (!extra || typeof extra !== 'object' || !('signal' in extra)) return undefined;
  const signal = (extra as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function strictRuntimeInputSchema(registry: CapabilityRegistry, capabilityId: string) {
  const capability = registry.get(capabilityId);
  if (!capability || !(capability.input instanceof z.ZodObject)) {
    throw new Error(`Connector runtime capability '${capabilityId}' has no object input schema.`);
  }
  return capability.tier === 'destructive'
    ? capability.input.extend(approvalTokenArgument())
    : capability.input;
}

/**
 * Build one request-scoped MCP server exposing exact principal-bound discovery and execution tools.
 *
 * @param registry - Fully composed server capability registry.
 * @param principal - Authenticated runtime principal resolved by the loopback listener.
 * @returns MCP server whose handlers retain the authenticated principal.
 */
export function createConnectorRuntimeMcpServer(
  registry: CapabilityRegistry,
  principal: ServerPrincipalProof
): McpServer {
  const server = new McpServer({ name: 'dorkos-connections', version: SERVER_VERSION });
  for (const capabilityId of CONNECTOR_RUNTIME_CAPABILITY_IDS) {
    const capability = registry.get(capabilityId);
    if (!capability) {
      throw new Error(`Connector runtime capability '${capabilityId}' is not registered.`);
    }
    server.registerTool(
      capability.id,
      {
        description: capability.description,
        inputSchema: strictRuntimeInputSchema(registry, capabilityId),
        annotations: deriveMcpAnnotations(capability),
      },
      async (args: Record<string, unknown>, extra: unknown) =>
        invokeCapabilityAsMcpResult(
          registry,
          capability.id,
          args,
          { serverPrincipal: principal },
          undefined,
          abortSignalOf(extra)
        )
    );
  }
  return server;
}
