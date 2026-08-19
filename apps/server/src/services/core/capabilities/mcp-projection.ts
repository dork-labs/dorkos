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
  isFreshApprovalAsk,
  splitApprovalToken,
  type ApprovalRequiredPayload,
} from './tier-enforcement.js';
import {
  awaitCapabilityApproval,
  type CapabilityApprovalHold,
  type CapabilityHoldSession,
} from './capability-approval-hold.js';
import { projectInSessionCard } from './in-session-card.js';
import type { ApprovalService } from '../approvals/index.js';

/**
 * What the IN-SESSION MCP surface threads through a tool call that the
 * sessionless surfaces (external `/mcp`, HTTP) have nothing to offer: the live
 * conversation itself.
 *
 * Two things ride it, and they are independent. A destructive ask HOLDS on
 * `approvals` and resumes on the person's decision; a capability declaring
 * `inSessionCard` draws a card on `session` and does not wait for anything.
 *
 * `approvals` is optional as a TYPE CONVENIENCE, not because a real surface ships
 * without it: the in-session adapter only builds this seam when the approval
 * service is wired, so every production caller supplies it. What optionality buys
 * is a test (or a future card-only surface) that wants a session without standing
 * up an approval service, and — the reason it is worth the honesty of saying so —
 * it keeps card-drawing from being silently gated on a service that has nothing
 * to do with cards.
 */
export interface InSessionSurface {
  /** The live session inline cards and hold cards are pushed onto. */
  session: CapabilityHoldSession;
  /** The approval primitive a destructive hold waits on, when one is wired. */
  approvals?: Pick<ApprovalService, 'awaitDecision' | 'getPending'>;
  /** The tool call's abort signal — a mid-turn interrupt ends any hold. */
  signal?: AbortSignal;
  /** Override the hold cap (tests). */
  capMs?: number;
}

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
 * @param surface - Optional in-session seam. Two independent things ride it:
 *   a FRESH destructive approval ({@link isFreshApprovalAsk}) HOLDS inline and
 *   resumes on a grant (DOR-939), and a capability declaring `inSessionCard`
 *   draws its card in the conversation (DOR-1004). Omitted on every sessionless
 *   surface (external `/mcp`, HTTP), which keep the unchanged token/poll flow
 *   and the unchanged full payload.
 * @returns The MCP text-content result.
 */
export async function invokeCapabilityAsMcpResult(
  registry: CapabilityRegistry,
  id: string,
  args: unknown,
  context?: CapabilityInvocationContext,
  surface?: InSessionSurface
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
    const plain = await invokeThroughRegistry(registry, id, input, context, approvalToken);
    // The card is drawn from the SUCCESSFUL result and nothing else: a refusal
    // or a throw produced no sign-in link, so there is nothing to put on screen.
    if (surface && capability?.inSessionCard) {
      return textResult(
        projectInSessionCard(capability.inSessionCard, surface.session, input, plain)
      );
    }
    return textResult(plain);
  } catch (err) {
    if (err instanceof CapabilityGateRefusal) {
      const decision = err.decision;
      // In-session hold: a refusal carrying a FRESH approval — one the gate just
      // minted, that nobody has seen — can wait for the operator and resume on a
      // grant, instead of returning the poll payload immediately. That is every
      // ask, not only the first: a token that expired, was already spent, named
      // another action, or matches nothing gets a brand-new approval too
      // (DOR-987). Every other refusal — a ceiling denial, the
      // `awaiting_decision` echo of an approval already on screen, a deny —
      // returns its payload exactly as before, and so does this one on any
      // sessionless surface (no `hold`).
      if (
        surface?.approvals &&
        decision.outcome === 'approval_required' &&
        isFreshApprovalAsk(decision.payload)
      ) {
        const hold: CapabilityApprovalHold = {
          approvals: surface.approvals,
          session: surface.session,
          ...(surface.signal ? { signal: surface.signal } : {}),
          ...(surface.capMs !== undefined ? { capMs: surface.capMs } : {}),
        };
        return holdAndResume(registry, id, input, context, decision.payload, hold);
      }
      // A gated or refused call returns the gate's structured payload as an
      // ordinary result (not `isError`): needing an approval is a step in a
      // protocol, not a failure, which is exactly how the marketplace's
      // `requires_confirmation` result has always behaved.
      return textResult(decision.payload);
    }
    if (err instanceof CapabilityToolError) {
      return textResult(err.payload, true);
    }
    throw err;
  }
}

/**
 * Invoke a capability through the registry on the MCP retry channel, carrying any
 * approval token the caller (or a resume) presented.
 *
 * Built field by field rather than spreading the caller's context object: the
 * in-session resolver hands out ONE memoized context per session, so spreading it
 * would forward whatever a shared object happened to carry into a call it has
 * nothing to do with. Only the adapter's own facts reach the registry — and note
 * what is absent: an MCP adapter never mints a trusted marker, because everything
 * arriving here arrived over the wire.
 *
 * **The cost of the allowlist is that a new fact has to be added here or it is
 * silently dropped**, which is what happened to `agentIdentityPresented` on its
 * first pass (DOR-1361): the external `/mcp` router set it, the handler never saw
 * it, and a revoked agent kept posting as the operator with every other seam
 * fixed. Anything a SURFACE observes about its caller belongs in this list; the
 * list is not a security boundary, it is a guard against a shared object's
 * leftovers.
 */
function invokeThroughRegistry(
  registry: CapabilityRegistry,
  id: string,
  input: unknown,
  context: CapabilityInvocationContext | undefined,
  approvalToken: string | undefined
): Promise<unknown> {
  return registry.invoke(id, input, {
    ...(context?.identity ? { identity: context.identity } : {}),
    ...(context?.agentIdentityPresented ? { agentIdentityPresented: true } : {}),
    ...(context?.userId ? { userId: context.userId } : {}),
    ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
    ...(approvalToken ? { approvalToken } : {}),
    retryChannel: 'mcp-argument',
  });
}

/**
 * Hold a fresh destructive ask inline until the operator decides, then resume.
 *
 * On `granted`/`denied` the call is re-invoked with the granted token: the gate
 * consumes it and returns the REAL result on a grant, or throws a
 * {@link CapabilityGateRefusal} carrying the `denied` payload on a refusal. On any
 * no-decision ending (`timeout` past the cap, `expired`) the held call degrades to
 * the EXACT `approval_required` payload today's poll flow returns — never worse.
 */
async function holdAndResume(
  registry: CapabilityRegistry,
  id: string,
  input: unknown,
  context: CapabilityInvocationContext | undefined,
  payload: ApprovalRequiredPayload,
  hold: CapabilityApprovalHold
): Promise<CallToolResult> {
  const outcome = await awaitCapabilityApproval(hold, payload);
  if (outcome !== 'granted' && outcome !== 'denied') return textResult(payload);
  try {
    return textResult(
      await invokeThroughRegistry(registry, id, input, context, payload.approvalToken)
    );
  } catch (err) {
    if (err instanceof CapabilityGateRefusal) return textResult(err.decision.payload);
    if (err instanceof CapabilityToolError) return textResult(err.payload, true);
    throw err;
  }
}
