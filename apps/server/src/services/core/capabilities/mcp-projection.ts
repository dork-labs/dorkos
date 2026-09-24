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
 * - {@link capabilityInputShape} recovers the Zod field-map both SDKs want, via
 *   {@link portableInputShape}, which keeps a `.default(…)` field readable as
 *   optional by a Zod copy that is not ours.
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
import { CapabilityImageResult, CapabilityToolError } from './mcp-envelope.js';
import {
  APPROVAL_TOKEN_ARGUMENT,
  CapabilityGateRefusal,
  isFreshApprovalAsk,
  splitApprovalToken,
  type ApprovalRequiredPayload,
} from './tier-enforcement.js';
import {
  approvalNoLongerValid,
  awaitCapabilityApproval,
  type CapabilityApprovalHold,
  type CapabilityHoldSession,
} from './capability-approval-hold.js';
import { projectInSessionCard } from './in-session-card.js';
import { canRaiseApproval } from './permission-enforcement.js';
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
  /**
   * The approval primitive a destructive hold waits on, when one is wired — and,
   * while it waits, the single-delivery claim it holds so the out-of-band verdict
   * deliverer cannot answer the same approval twice (spec
   * `approval-verdict-delivery`).
   */
  approvals?: Pick<
    ApprovalService,
    'awaitDecision' | 'getPending' | 'claimVerdictDelivery' | 'releaseVerdictDelivery'
  >;
  /** The tool call's abort signal — a mid-turn interrupt ends any hold. */
  signal?: AbortSignal;
  /** Override the hold cap (tests). */
  capMs?: number;
  /**
   * Whether nobody can answer a card inside the current turn, read per call
   * (spec `agent-permissions` D6). A hold whose turn is unattended does not
   * hold; see `awaitCapabilityApproval`.
   */
  unattended?: () => boolean;
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
 * A capability that can raise an approval card (`destructive`, or an `act`
 * capability with a permission area, which a person may set to Ask) gains one
 * extra advertised argument,
 * `approvalToken`, which is how a retry carries the approval a person granted
 * (spec `agent-trust` §3.2). It is deliberately NOT part of the capability's own
 * input schema: the approval binds to a hash of the input, so a token carried
 * inside the input would change the hash it is checked against. The choke point
 * splits it back off before parsing ({@link splitApprovalToken}).
 *
 * The map then goes through {@link portableInputShape}, which re-labels every
 * `.default(…)` field as an ordinary optional one so a foreign Zod cannot read it
 * as required (DOR-2053). The default still applies — the registry re-parses
 * against the capability's own schema.
 *
 * @param capability - The capability whose input schema to project.
 * @returns The field-map input schema for MCP tool registration.
 */
export function capabilityInputShape(capability: CapabilityDefinition): z.ZodRawShape {
  const shape = (capability.input as z.ZodObject<z.ZodRawShape>).shape;
  if (!canRaiseApproval(capability)) return portableInputShape(shape);
  return portableInputShape({ ...shape, ...approvalTokenArgument() });
}

/**
 * The substituting wrapper on a field, if it has one: the schema underneath it
 * and the value it fills in for an absent key.
 *
 * `.default()` and `.prefault()` are the two wrappers that SUBSTITUTE; a
 * `.optional()` around either is transparent here, because the rebuilt field is
 * made optional again anyway. Everything else — a plain `.optional()`, a
 * required field — returns `undefined` and is advertised untouched.
 */
function substitutingDefault(
  field: z.core.$ZodType
): { inner: z.ZodType; value: unknown } | undefined {
  if (field instanceof z.ZodDefault || field instanceof z.ZodPrefault) {
    return { inner: field.unwrap() as z.ZodType, value: field.def.defaultValue };
  }
  if (field instanceof z.ZodOptional) {
    return substitutingDefault(field.unwrap() as z.core.$ZodType);
  }
  return undefined;
}

/**
 * Re-advertise every `.default(…)` field of an MCP input shape as an ordinary
 * optional one, so a no-argument call survives the trip through a FOREIGN Zod.
 *
 * Zod 4.6 split optionality into three rungs — required, `"optional"`, and a new
 * middle `"defaulted"` — and moved `.default(…)` onto the middle one
 * (`_zod.optin`, `zod/v4/core/schemas.js`). A raw field map is not a schema: the
 * consumer rebuilds it into an object of its OWN making, and that object decides
 * which keys may be absent by reading those rungs. The Claude Agent SDK inlines
 * its own copies of Zod and the MCP SDK rather than importing ours, and that copy
 * predates the middle rung: it asks `optin === "optional"`, reads `"defaulted"`,
 * and files the key as required. Calling `list_capabilities` with no arguments
 * therefore failed validation before the handler ever ran — `Invalid input:
 * expected nonoptional, received undefined` at `limit` — and so did eight more
 * tools with a defaulted field (DOR-2053).
 *
 * So the shape that crosses that boundary uses only the two rungs every Zod 4
 * agrees on. **The default itself is not dropped**: `registry.invoke` parses the
 * arguments through the capability's OWN schema, which still carries
 * `.default(…)`, so an absent key is filled exactly as before — the shape here is
 * an ADVERTISEMENT, and the registry is the validator. The `default` and
 * `description` annotations are carried onto the rebuilt field, so the JSON
 * Schema the model reads is unchanged too.
 *
 * This works because a capability's arguments are parsed TWICE. A hand-registered
 * tool is parsed once and gets whatever the SDK produced, so the same rewrite
 * there would trade a loud failure for a silent `undefined` — which is why
 * `mcp-tool-gate.ts` does not do it, and why a hand-registered tool must not
 * default an argument at all.
 *
 * `runtimes/claude-code/mcp-tools/__tests__/mcp-default-arguments.test.ts` holds
 * the drift guard for both halves — it lives there because only that directory
 * may import the Agent SDK, and the guard has to fail against the real SDK rather
 * than against a restatement of it. The invariant it pins is about RAW FIELD MAPS,
 * not about tools: no raw field map crossing to the Agent SDK may carry a field on
 * the middle rung. A capability that hands over a whole `ZodObject` instead is
 * outside it and needs nothing from this function — the object is parsed by the
 * schema's own `run`, so `optin` is never consulted. That is why the seven
 * `CONNECTOR_RUNTIME_CAPABILITY_IDS`, one of which defaults `requestedEvents`, are
 * safe while declaring `surfaces: {}` and never reaching here.
 *
 * Still required as of `@anthropic-ai/claude-agent-sdk@0.3.272` (the latest
 * release on 2026-09-15): its bundle contains no `"defaulted"` string and still
 * asks `optin === "optional"`, and a raw `.default(…)` field run through its
 * `tool()` still fails the same way. Which points at the real retirement: the
 * cause is the raw field map, so registering these capabilities with their full
 * `ZodObject` — the way `registerClaudeConnectorCapabilityTools` already does —
 * would remove the need for this function altogether.
 *
 * @param shape - The advertised field map.
 * @returns The same map, with every substituting field re-labelled optional.
 *   Returns the input untouched when there is nothing to re-label.
 */
function portableInputShape(shape: z.ZodRawShape): z.ZodRawShape {
  let rebuilt: Record<string, z.core.$ZodType> | undefined;
  for (const [key, field] of Object.entries(shape)) {
    const substituting = substitutingDefault(field);
    if (!substituting) continue;
    rebuilt ??= { ...shape };
    const description = (field as z.ZodType).description;
    rebuilt[key] = substituting.inner.optional().meta({
      ...(description === undefined ? {} : { description }),
      default: substituting.value,
    });
  }
  return rebuilt ?? shape;
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

/**
 * Wrap a plain payload into the MCP envelope both servers return.
 *
 * Text, unless the capability handed back a {@link CapabilityImageResult} — in
 * which case the picture leads and the JSON follows it, which is the two-block
 * shape a model can actually look at.
 *
 * @param payload - What the handler returned.
 * @param isError - Whether this is the handler's failure path.
 * @returns The MCP result.
 */
function textResult(payload: unknown, isError = false): CallToolResult {
  if (payload instanceof CapabilityImageResult) {
    return {
      content: [
        { type: 'image' as const, data: payload.image.data, mimeType: payload.image.mimeType },
        { type: 'text' as const, text: JSON.stringify(payload.payload, null, 2) },
      ],
      ...(isError ? { isError: true } : {}),
    };
  }
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
  surface?: InSessionSurface,
  signal?: AbortSignal
): Promise<CallToolResult> {
  const capability = registry.get(id);
  // Only a tool that can raise a card advertises `approvalToken`, so only such a
  // call has one to lift off — anything else gets its arguments through untouched
  // rather than silently losing a field of that name.
  const { approvalToken, input } =
    capability && canRaiseApproval(capability)
      ? splitApprovalToken(args)
      : { approvalToken: undefined, input: args };

  try {
    const plain = await invokeThroughRegistry(
      registry,
      id,
      input,
      context,
      approvalToken,
      signal ?? surface?.signal
    );
    // The card is drawn from the SUCCESSFUL result and nothing else: a refusal
    // or a throw produced no sign-in link, so there is nothing to put on screen.
    if (surface && capability?.inSessionCard) {
      // `input` is what the caller SENT, not what the registry parsed, so a card
      // reading a field the capability defaults would see `undefined` — neither
      // card capability has one today (DOR-2053).
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
          ...(surface.unattended ? { unattended: surface.unattended } : {}),
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
  approvalToken: string | undefined,
  signal?: AbortSignal
): Promise<unknown> {
  return registry.invoke(id, input, {
    ...(context?.identity ? { identity: context.identity } : {}),
    ...(context?.agentIdentityPresented ? { agentIdentityPresented: true } : {}),
    ...(context?.userId ? { userId: context.userId } : {}),
    ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context?.cwd ? { cwd: context.cwd } : {}),
    ...(context?.serverPrincipal ? { serverPrincipal: context.serverPrincipal } : {}),
    ...((signal ?? context?.signal) ? { signal: signal ?? context?.signal } : {}),
    ...(approvalToken ? { approvalToken } : {}),
    retryChannel: 'mcp-argument',
  });
}

/**
 * Hold a fresh destructive ask inline until the operator decides, then resume.
 *
 * On `granted`/`denied` the call is re-invoked with the granted token: the gate
 * consumes it and returns the REAL result on a grant, or throws a
 * {@link CapabilityGateRefusal} carrying the `denied` payload on a refusal. On
 * `timeout` — the cap ran out while the window stayed open — the held call
 * degrades to the EXACT `approval_required` payload today's poll flow returns,
 * never worse. On `expired` it returns `approval_no_longer_valid` instead, because
 * by then that payload would be advertising a dead token and a card nobody can
 * answer (DOR-1932).
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
  // The window closed (or the token was spent elsewhere) while this call waited,
  // so the poll payload is no longer true: there is no live card to answer and
  // the token is dead. Saying otherwise sent the agent to retry with it
  // (DOR-1932).
  if (outcome === 'expired') return textResult(approvalNoLongerValid(payload));
  // `timeout` alone still degrades verbatim — the cap ran out, not the window, so
  // the card really is still on the dashboard and the token really does still work.
  if (outcome !== 'granted' && outcome !== 'denied') return textResult(payload);
  try {
    return textResult(
      await invokeThroughRegistry(registry, id, input, context, payload.approvalToken, hold.signal)
    );
  } catch (err) {
    if (err instanceof CapabilityGateRefusal) return textResult(err.decision.payload);
    if (err instanceof CapabilityToolError) return textResult(err.payload, true);
    throw err;
  }
}
