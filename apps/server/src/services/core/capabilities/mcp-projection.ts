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
import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerId } from '@dorkos/shared/capabilities';

import type { CapabilityDefinition } from './capability-definition.js';
import type { CapabilityInvocationContext, CapabilityRegistry } from './registry.js';
import { CapabilityToolError } from './mcp-envelope.js';
import {
  APPROVAL_TOKEN_ARGUMENT,
  CapabilityGateRefusal,
  splitApprovalToken,
} from './tier-enforcement.js';

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
 * A `destructive` capability gains one extra advertised argument,
 * `approvalToken`, which is how a retry carries the approval a person granted
 * (spec `agent-trust` §3.2). It is deliberately NOT part of the capability's own
 * input schema: the approval binds to a hash of the input, so a token carried
 * inside the input would change the hash it is checked against. The choke point
 * splits it back off before parsing ({@link splitApprovalToken}).
 *
 * @param capability - The capability whose input schema to project.
 * @returns The field-map input schema for MCP tool registration.
 */
export function capabilityInputShape(capability: CapabilityDefinition): z.ZodRawShape {
  const shape = (capability.input as z.ZodObject<z.ZodRawShape>).shape;
  if (capability.tier !== 'destructive') return shape;
  return { ...shape, ...approvalTokenArgument() };
}

/**
 * The one extra MCP argument every `destructive` tool advertises, as a one-key
 * field map ready to spread into an input shape.
 *
 * Both the registry projection ({@link capabilityInputShape}) and the
 * hand-registered tool gate (`services/core/mcp-tool-gate.ts`) build their
 * destructive input shapes from this, because the failure it prevents is the same
 * on both paths and it is silent: an MCP argument that is not advertised is
 * stripped by the SDK before the handler sees it, so a destructive tool that
 * forgets this field tells the model to retry with a token the model has no way to
 * deliver. The gate then asks again, forever. One definition, so a surface cannot
 * advertise a token field the choke point does not read, or the reverse.
 *
 * @returns A one-key field map declaring the `approvalToken` argument.
 */
export function approvalTokenArgument(): z.ZodRawShape {
  return {
    [APPROVAL_TOKEN_ARGUMENT]: z
      .string()
      .optional()
      .describe(
        'Approval token from a previous call that returned status:approval_required. ' +
          'Omit on the first call. After the person approves in DorkOS, call again with ' +
          'the SAME arguments plus this token.'
      ),
  };
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

/** Wrap a plain payload into the MCP text envelope both servers return. */
function textResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Invoke a capability by id through the registry and re-wrap its plain result
 * into the MCP text envelope both servers return.
 *
 * This is the MCP half of the enforcement path (spec `agent-trust` §3.2). Both
 * MCP adapters funnel every tool call through here, and this function does not
 * gate: `registry.invoke` does, from the inside, so no adapter can forget it
 * (DOR-467). All this function adds is the two MCP-specific facts the registry
 * cannot work out for itself — the token rides a tool ARGUMENT rather than a
 * header, so retry instructions must name that argument — and the translation of
 * a refusal back into the MCP envelope.
 *
 * The registry validates the input, gates, runs `invoke`, and returns plain data;
 * this function serializes that data into a text block. A
 * {@link CapabilityToolError} — the handler's `isError` path, re-raised at the
 * plain-data seam — is caught and re-wrapped into the matching `isError` envelope
 * so the wire result is byte-equivalent to the phase-1 handler's. Any other throw
 * (e.g. an input `ZodError`) propagates to the MCP SDK, exactly as the descriptor
 * registration did.
 *
 * @param registry - The composed capability registry.
 * @param id - The capability id to invoke.
 * @param args - Raw tool arguments from the MCP client, optionally carrying an
 *   `approvalToken` for a destructive retry.
 * @param context - Optional request-scoped context (the calling agent's
 *   identity, resolved from the `X-DorkOS-Agent` header or the session's working
 *   directory). Omitting it invokes unattributed, exactly as before.
 * @returns The MCP text-content result.
 */
export async function invokeCapabilityAsMcpResult(
  registry: CapabilityRegistry,
  id: string,
  args: unknown,
  context?: CapabilityInvocationContext
): Promise<CallToolResult> {
  const capability = registry.get(id);
  // Only a destructive tool advertises `approvalToken`, so only a destructive
  // call has one to lift off — anything else gets its arguments through untouched
  // rather than silently losing a field of that name.
  const { approvalToken, input } =
    capability?.tier === 'destructive'
      ? splitApprovalToken(args)
      : { approvalToken: undefined, input: args };

  try {
    // Build the context field by field rather than spreading the caller's object.
    // The in-session resolver hands out ONE memoized context per session, so
    // spreading it would forward whatever a shared object happened to carry into
    // a call it has nothing to do with. Only the adapter's own facts may reach the
    // registry — and note what is absent: an MCP adapter never mints a trusted
    // marker, because everything arriving here arrived over the wire.
    const data = await registry.invoke(id, input, {
      ...(context?.identity ? { identity: context.identity } : {}),
      ...(approvalToken ? { approvalToken } : {}),
      retryChannel: 'mcp-argument',
    });
    return textResult(data);
  } catch (err) {
    // A gated or refused call returns the gate's structured payload as an
    // ordinary result (not `isError`): needing an approval is a step in a
    // protocol, not a failure, which is exactly how the marketplace's
    // `requires_confirmation` result has always behaved.
    if (err instanceof CapabilityGateRefusal) {
      return textResult(err.decision.payload);
    }
    if (err instanceof CapabilityToolError) {
      return textResult(err.payload, true);
    }
    throw err;
  }
}
