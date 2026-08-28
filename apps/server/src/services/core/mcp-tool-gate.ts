/**
 * The tier gate for hand-registered MCP tools (DOR-468).
 *
 * ## Where this sits
 *
 * The Capability Registry gates itself: the tier check lives inside
 * `registry.invoke`, so any surface reaching a capability inherits it (DOR-467).
 * The 47 hand-registered MCP tools do not go through the registry — they are
 * `tool()` definitions and `server.registerTool()` calls with their own handlers —
 * so they need a choke point of their own. This is it, and there is exactly one per
 * server:
 *
 * - {@link gateHandRegisteredMcpTools} wraps the in-session `dorkos` server's tool
 *   array, in `runtimes/claude-code/mcp-tools/index.ts`.
 * - {@link gatedToolRegistrar} wraps the external `/mcp` server's registrar, in
 *   `core/mcp-server.ts`.
 *
 * Both call the same {@link enforceCapabilityTier} the registry calls. This is
 * deliberately NOT a second enforcement implementation: a tool presents itself to
 * the existing gate as a {@link GatedAction} (`tier-enforcement.ts`), which is the
 * four fields that gate actually reads. `__tests__/gate-bypass-scan.test.ts` pins
 * who may call `enforceCapabilityTier(`, so a third path cannot appear unnoticed.
 *
 * ## Why the wrapper is at the composition root, not at each handler
 *
 * A gate written into 47 handlers twice over is a gate somebody forgets on the
 * 48th. Wrapping the whole tool set in one place means a new tool is gated by
 * construction, and the lookup is eager: {@link gatedActionForMcpTool} throws for a
 * tool with no declared tier, at SERVER BUILD time. A tool added without a tier
 * therefore breaks every session immediately, rather than running ungated until
 * somebody reads the table.
 *
 * The external registrar is typed rather than merely conventional, and it took a
 * second attempt to make that sentence true. The per-domain `register*Tools`
 * functions take a {@link ToolRegistrar}, which is BRANDED: a raw `McpServer` does
 * not satisfy it and will not compile. The unbranded first version was structural,
 * so passing the real server compiled, passed every test, and quietly ungated 20
 * tools. Read the {@link ToolRegistrar} TSDoc before touching that type.
 *
 * ## What is audited, and what is not
 *
 * This gate writes an Activity record for every attempt it REFUSES or parks for
 * approval, through the same observer the registry uses. It writes nothing when a
 * call is allowed — including a `destructive` call that a person approved and that
 * then RAN. The tier gate does not audit allowed calls (the registry's attribution
 * observer does that, and it only runs inside `registry.invoke`, which these tools
 * never reach). So the trail for an approved deletion is the durable approval
 * record of the grant, not a line saying it happened. Closing that gap means an
 * attribution observer on this path; it is not in scope here, and it is written
 * down rather than left for somebody to discover from an empty feed.
 *
 * ## The retry argument, which is the thing most likely to be missed
 *
 * A `destructive` tool must ADVERTISE the `approvalToken` argument, on every server
 * it appears on. The MCP SDK parses a tool call against the advertised input schema
 * before the handler runs, so an unadvertised argument is stripped on the way in:
 * the gate would tell the model "retry with this token", the model would send it,
 * the token would evaporate, and the gate would ask again. Forever. The field is
 * added here from {@link approvalTokenArgument}, the same one-key definition the
 * registry projection uses, so the two cannot drift.
 *
 * The token rides BESIDE the input, never inside it: the approval binds to a hash
 * of the arguments, and a token carried as an argument would change the very hash
 * it is checked against. {@link splitApprovalToken} takes it back off before the
 * hash is computed, and the handler never sees it.
 *
 * ## These tools still POLL — they do not hold in-session
 *
 * The registry path can HOLD a destructive call inline while a person decides and
 * resume it in the same turn (DOR-939, `capabilities/capability-approval-hold.ts`).
 * This path cannot: a gated call here returns the `approval_required` payload and
 * the turn ends, so the person approves on the dashboard and then tells the agent
 * to retry. That applies to both hand-registered destructive tools — `tasks_delete`
 * and `mesh_unregister`.
 *
 * The inconsistency is deliberate and scoped out of DOR-939 rather than missed:
 * wiring the hold here means threading the live session's event queue into this
 * choke point, which the external `/mcp` server (the other caller) has no session
 * for. It is named here so the next person meets a decision instead of a mystery.
 *
 * ## What a tier does not do
 *
 * It decides whether a call needs a person's approval. It does not constrain what
 * the arguments may contain, and this module makes no claim about that. See
 * `mcp-tool-tiers.ts`.
 *
 * @module services/core/mcp-tool-gate
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

import type { AgentIdentity } from './agent-identity/agent-identity-service.js';
import { approvalTokenArgument } from './capabilities/mcp-projection.js';
import {
  enforceCapabilityTier,
  splitApprovalToken,
  type GatedAction,
} from './capabilities/tier-enforcement.js';
import { gatedActionForMcpTool } from './mcp-tool-tiers.js';

/**
 * The MCP text envelope the hand-registered handlers already return, reused here
 * so a gate result is shaped exactly like the result it replaces.
 *
 * A refusal is NOT `isError`. Needing a person's approval is a step in a protocol,
 * not a failure, and the registry path has always answered the same way.
 */
function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/**
 * What the gate concluded about one hand-registered tool call: either run the
 * handler with these arguments, or return this result instead.
 */
type GateOutcome =
  { allowed: true; input: Record<string, unknown> } | { allowed: false; result: CallToolResult };

/**
 * Run the tier gate for one hand-registered tool call.
 *
 * The arguments hashed into the approval are exactly the arguments the handler
 * will receive, minus the approval token. There is no second parse between this
 * check and the call, which is what makes the binding cover what actually runs —
 * the registry path has to assert schema parse-idempotence to get the same
 * property, because it parses once more on the way in.
 *
 * @param action - The tool's tier declaration, from the shared table.
 * @param args - The arguments the SDK parsed for this call.
 * @param identity - The calling agent, when the surface resolved one.
 * @returns Whether to proceed, and with what.
 */
function runGate(
  action: GatedAction,
  args: unknown,
  identity: AgentIdentity | undefined,
  interactive: boolean
): GateOutcome {
  // Only a destructive tool advertises `approvalToken`, so only a destructive call
  // has one to lift off. Anything else passes its arguments through untouched
  // rather than silently losing a field that happens to share the name.
  const { approvalToken, input } =
    action.tier === 'destructive'
      ? splitApprovalToken(args)
      : { approvalToken: undefined, input: args };

  const decision = enforceCapabilityTier({
    action,
    input,
    ...(identity ? { identity } : {}),
    ...(approvalToken ? { approvalToken } : {}),
    // An MCP client cannot set an HTTP header on a tool call, so the retry
    // instructions must name the tool ARGUMENT this module advertises.
    retryChannel: 'mcp-argument',
    // Wording only — see `TierEnforcementRequest.interactive`. The in-session
    // server can be told to open the panel for the operator; the external
    // `/mcp` server has no session and no `control_ui`, and the two entry
    // points below are what already tell those apart.
    interactive,
  });

  if (decision.outcome !== 'allowed')
    return { allowed: false, result: textResult(decision.payload) };
  return { allowed: true, input: (input ?? {}) as Record<string, unknown> };
}

/**
 * The advertised input schema for a tool, with the approval-token argument added
 * when the tool is `destructive`.
 */
function gatedInputSchema(action: GatedAction, schema: z.ZodRawShape): z.ZodRawShape {
  return action.tier === 'destructive' ? { ...schema, ...approvalTokenArgument() } : schema;
}

/**
 * The structural shape of a Claude Agent SDK tool definition, as `tool()` returns
 * it.
 *
 * Declared structurally rather than imported, so this module stays outside the
 * runtime-SDK confinement rule (`@anthropic-ai/claude-agent-sdk` is banned outside
 * `services/runtimes/claude-code/`). It is a plain data object, so nothing is lost.
 */
export interface SdkMcpTool {
  /** The tool name the model calls. */
  name: string;
  /** The model-facing description. Carried through untouched; the gate never reads it. */
  description: string;
  /** The advertised input field map. */
  inputSchema: z.ZodRawShape;
  /**
   * MCP tool annotations, when the registering domain set any. Carried so a
   * definition can be rebuilt field for field (the in-session server re-runs each
   * gated tool through the SDK's `tool()` to attach its loading policy); dropping
   * it there would silently discard an annotation a domain had declared.
   */
  annotations?: ToolAnnotations;
  /**
   * The tool's implementation.
   *
   * Declared with method syntax deliberately: that makes the parameter check
   * bivariant, so this one interface can both ACCEPT a concrete tool (whose
   * handler takes its own narrow argument shape) and be RETURNED where the SDK
   * wants its own wider type. A property-style function would be contravariant
   * and could only do one of the two.
   */
  handler(args: Record<string, unknown>, extra: unknown): Promise<CallToolResult>;
}

/**
 * Put every hand-registered in-session tool behind the tier gate.
 *
 * Called once, on the whole tool array, in the in-session server's composition
 * root. Each tool's tier is resolved here — at build time — so a tool with no
 * declared tier throws before the server exists.
 *
 * @template T - The concrete SDK tool definition type, preserved on the way out.
 * @param tools - The hand-registered tool definitions to gate.
 * @param resolveContext - Resolves the calling agent for this session, awaited per
 *   call. Only the identity is read: the resolver memoizes ONE context per session,
 *   so reading anything else off it would forward a fact from one call into
 *   another. Omitted in tests and introspection paths, which gate as an
 *   unidentified caller — which is still gated, because the tier decides that.
 * @returns The same tools, gated, with `approvalToken` advertised where required.
 * @throws If any tool declares no tier in `MCP_TOOL_TIERS`.
 */
export function gateHandRegisteredMcpTools<T extends SdkMcpTool>(
  tools: readonly T[],
  resolveContext?: () => Promise<{ identity?: AgentIdentity } | undefined>
): T[] {
  return tools.map((definition) => {
    const action = gatedActionForMcpTool(definition.name);
    const handler = definition.handler;
    return {
      ...definition,
      inputSchema: gatedInputSchema(action, definition.inputSchema),
      handler: async (args: never, extra: unknown): Promise<CallToolResult> => {
        // `interactive: true` — this entry point wraps the IN-SESSION server,
        // where `control_ui` exists, so a gated call may be told to put the
        // approval in front of the operator (DOR-1570).
        const outcome = runGate(action, args, (await resolveContext?.())?.identity, true);
        if (!outcome.allowed) return outcome.result;
        return handler(outcome.input as never, extra);
      },
      // The wrapper reproduces the SDK's tool shape field for field; the cast
      // restores the caller's concrete type, which a spread of a generic widens.
    } as unknown as T;
  });
}

/**
 * The brand that makes {@link ToolRegistrar} mean "gated" rather than merely
 * "has a `registerTool` method".
 *
 * Type-only and never exported: `declare const` means this has NO runtime value,
 * so the brand costs nothing at runtime and nothing outside this module can name
 * it. That is what makes {@link ToolRegistrar} nominal rather than structural.
 * {@link gatedToolRegistrar} claims it with a type assertion, never by writing a
 * property — writing one would throw, since the symbol does not exist at run time.
 */
declare const GATED: unique symbol;

/**
 * What the per-domain external registration functions register against.
 *
 * ## Why this is branded, which is the whole guarantee
 *
 * The obvious spelling, `Pick<McpServer, 'registerTool'>`, is STRUCTURAL — and a
 * real `McpServer` has a `registerTool`, so it satisfies it. Review proved what
 * that costs: swapping `registrar` back to the raw `server` for three domains in
 * `mcp-server.ts` type-checked cleanly, passed all 33 gate tests, and left 20
 * external tools silently ungated. The guarantee was one line passing the right
 * variable, which is a convention, not a type.
 *
 * The brand fixes that. A raw `McpServer` now fails to compile with `Property
 * '[GATED]' is missing`, so the ONLY thing a registration function can be handed
 * is a registrar that ran the gate. That matters even though today's runtime
 * consequence is zero (none of those three domains holds a destructive tool):
 * promoting any tool in them would otherwise re-open the exact silent regression
 * this module exists to close, and it would look like a one-word change.
 */
export type ToolRegistrar = Pick<McpServer, 'registerTool'> & { readonly [GATED]: true };

/**
 * Compile-time proof that the brand is load-bearing.
 *
 * Resolves to `true` while a raw `McpServer` does NOT satisfy {@link ToolRegistrar},
 * and to `never` the moment it does — at which point this assignment stops
 * compiling and `tsc` names this line.
 *
 * It lives in production source rather than in the test file on purpose, though
 * the reason has narrowed. It used to be that `apps/server/tsconfig.json` excluded
 * `src/**\/__tests__/**` wholesale, so a `@ts-expect-error` anywhere in a test was
 * decoration that could never fail. DOR-508 put the test files in the tsc program,
 * so that is no longer true in general.
 *
 * It is still true for `__tests__/mcp-tool-gate.test.ts` specifically: that file is
 * one of the test files quarantined in the tsconfig's `exclude` while its own type
 * errors are worked off, so a pin written there today would still be decoration.
 * Once it leaves quarantine, this pin can move next to the tests it describes. The
 * one guarantee this whole module rests on deserves a check that can actually fail.
 */
const _rawServerIsNotARegistrar: McpServer extends ToolRegistrar ? never : true = true;

/**
 * Wrap an external `McpServer` so every tool registered through it runs the tier
 * gate first.
 *
 * @param server - The real external `McpServer` to register against.
 * @param identity - The calling agent, when the request carried a resolved
 *   identity token. This server is rebuilt per request, so one identity covers
 *   every tool it registers.
 * @returns A registrar to hand to the per-domain registration functions.
 */
export function gatedToolRegistrar(server: McpServer, identity?: AgentIdentity): ToolRegistrar {
  const registerTool: ToolRegistrar['registerTool'] = ((
    name: string,
    config: { inputSchema?: z.ZodRawShape },
    cb: (args: never, extra: unknown) => Promise<CallToolResult>
  ) => {
    const action = gatedActionForMcpTool(name);
    return server.registerTool(
      name,
      { ...config, inputSchema: gatedInputSchema(action, config.inputSchema ?? {}) },
      (async (args: never, extra: unknown): Promise<CallToolResult> => {
        // `interactive: false` — the external `/mcp` server is sessionless, so
        // the UI tools are not registered and must not be suggested.
        const outcome = runGate(action, args, identity, false);
        if (!outcome.allowed) return outcome.result;
        return cb(outcome.input as never, extra);
        // The SDK's `registerTool` is generic over the input and output shapes it
        // is handed; this wrapper is deliberately shape-agnostic, so the two casts
        // bridge that and are confined to this factory.
      }) as never
    );
  }) as ToolRegistrar['registerTool'];

  // The brand exists only in the type system — `GATED` is `declare`d, so it has no
  // runtime value and writing `[GATED]: true` here would throw. The assertion is
  // the whole mechanism, and this factory is the one place entitled to make it,
  // because it is the one place that ran the gate.
  return { registerTool } as ToolRegistrar;
}
