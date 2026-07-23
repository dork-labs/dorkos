/**
 * Project registry capabilities onto MCP tool registrations (spec
 * `capability-registry`, task 2.2).
 *
 * Both MCP servers — the in-session `dorkos` server (Claude Agent SDK `tool()`)
 * and the external `/mcp` server (`McpServer.registerTool`) — generate their
 * tool surface from the same registry through these transport-neutral helpers:
 *
 * - {@link capabilitiesForMcpServer} selects the capabilities a given server
 *   advertises (from each capability's `surfaces.mcp.servers`).
 * - {@link capabilityInputShape} recovers the Zod field-map both SDKs want.
 * - {@link deriveMcpAnnotations} regenerates the four MCP tool-annotation hints
 *   from the permission tier plus the two per-tool overrides a tier can't
 *   express (`readOnlyHint`/`destructiveHint` from the tier; `idempotentHint`/
 *   `openWorldHint` from `surfaces.mcp.annotations`).
 * - {@link invokeCapabilityAsMcpResult} runs a capability through the registry
 *   (which validates input and returns plain data) and re-wraps the plain
 *   result — or a {@link CapabilityToolError} — into the MCP text envelope.
 *
 * The two thin SDK-specific adapters (`external-mcp/capability-mcp-tools.ts` and
 * `runtimes/claude-code/mcp-tools/capability-mcp-tools.ts`) do nothing but map
 * these helpers onto their respective SDK call — replacing the former
 * hand-written descriptor walks.
 *
 * @module services/core/capabilities/mcp-projection
 */
import type { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerId } from '@dorkos/shared/capabilities';

import type { CapabilityDefinition } from './capability-definition.js';
import type { CapabilityRegistry } from './registry.js';
import { CapabilityToolError } from './mcp-envelope.js';

/**
 * The capabilities the given MCP server advertises, in registration order —
 * those whose `surfaces.mcp.servers` includes `server`.
 *
 * @param registry - The composed capability registry.
 * @param server - The MCP server selecting its tools.
 * @returns The capabilities to register on that server.
 */
export function capabilitiesForMcpServer(
  registry: CapabilityRegistry,
  server: McpServerId
): CapabilityDefinition[] {
  return registry.capabilities.filter((cap) => cap.surfaces.mcp?.servers.includes(server));
}

/**
 * Recover the Zod field-map (a `ZodRawShape`) both MCP SDKs expect as a tool's
 * input schema from a capability's `input` object schema. Every migrated
 * capability declares `input` as a `z.object(...)`, so its `.shape` is the same
 * field map the phase-1 descriptors passed straight to `registerTool` / `tool`.
 *
 * @param capability - The capability whose input schema to project.
 * @returns The field-map input schema for MCP tool registration.
 */
export function capabilityInputShape(capability: CapabilityDefinition): z.ZodRawShape {
  return (capability.input as z.ZodObject<z.ZodRawShape>).shape;
}

/**
 * Regenerate a capability's four MCP tool-annotation hints.
 *
 * `readOnlyHint` and `destructiveHint` derive from the permission tier
 * (`observe` → read-only; `destructive` → destructive). `destructiveHint` is
 * emitted EXPLICITLY as `false` for every non-`destructive` tool because the
 * MCP SDK defaults it to `true`. `idempotentHint` and `openWorldHint` vary
 * within a tier and come from `surfaces.mcp.annotations` (both default `false`).
 *
 * @param capability - The capability whose annotations to derive.
 * @returns The four-hint MCP tool annotations.
 */
export function deriveMcpAnnotations(capability: CapabilityDefinition): ToolAnnotations {
  const hints = capability.surfaces.mcp?.annotations;
  return {
    readOnlyHint: capability.tier === 'observe',
    destructiveHint: capability.tier === 'destructive',
    idempotentHint: hints?.idempotentHint ?? false,
    openWorldHint: hints?.openWorldHint ?? false,
  };
}

/**
 * The set of MCP tool names in the read-only carve-out — capabilities flagged
 * `surfaces.mcp.readOnlyCarveOut` that the external server advertises. This is
 * the registry-derived portion of `READ_ONLY_MCP_TOOL_NAMES`, the tokenless
 * carve-out for the login-off `/mcp` surface.
 *
 * @param capabilities - The capabilities to scan (typically a registry's or a
 *   domain set's).
 * @returns The read-only carve-out tool names on the external server.
 */
export function readOnlyCarveOutToolNames(
  capabilities: readonly CapabilityDefinition[]
): Set<string> {
  const names = new Set<string>();
  for (const cap of capabilities) {
    const mcp = cap.surfaces.mcp;
    if (mcp?.readOnlyCarveOut && mcp.servers.includes('external')) {
      names.add(mcp.toolName);
    }
  }
  return names;
}

/**
 * Invoke a capability by id through the registry and re-wrap its plain result
 * into the MCP text envelope both servers return.
 *
 * The registry validates `args` against the capability's input schema, runs its
 * `invoke`, and returns plain data; this function serializes that data into a
 * text block. A {@link CapabilityToolError} — the handler's `isError` path,
 * re-raised at the plain-data seam — is caught and re-wrapped into the matching
 * `isError` envelope so the wire result is byte-equivalent to the phase-1
 * handler's. Any other throw (e.g. an input `ZodError`) propagates to the MCP
 * SDK, exactly as the descriptor registration did.
 *
 * @param registry - The composed capability registry.
 * @param id - The capability id to invoke.
 * @param args - Raw tool arguments from the MCP client.
 * @returns The MCP text-content result.
 */
export async function invokeCapabilityAsMcpResult(
  registry: CapabilityRegistry,
  id: string,
  args: unknown
): Promise<CallToolResult> {
  try {
    const data = await registry.invoke(id, args);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    if (err instanceof CapabilityToolError) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(err.payload, null, 2) }],
        isError: true,
      };
    }
    throw err;
  }
}
