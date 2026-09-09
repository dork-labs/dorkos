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
 * ## These tools HOLD in-session too, when there is a session (DOR-1930)
 *
 * The registry path has been able to HOLD a destructive call inline while a
 * person decides, and resume it in the same turn, since DOR-939
 * (`capabilities/capability-approval-hold.ts`). This path could not, and the gap
 * was scoped out rather than missed: wiring the hold here means threading the
 * live session's event queue into this choke point, which the external `/mcp`
 * server — the other caller — has no session for.
 *
 * That scope-out WAS the bug. An operator approved four `mesh_unregister` cards
 * and the requesting agent was never told, because these two tools were the ones
 * still on the poll flow: the call returned `approval_required`, the turn ended,
 * and nothing ever said a person had answered. The human became the message bus.
 *
 * The seam is now optional rather than absent. {@link gateHandRegisteredMcpTools}
 * takes a hold; with one, a FRESH destructive ask waits for the decision and
 * resumes in the same turn. Without one — the external `/mcp` server, the
 * introspection stub, a hermetic test — the poll payload is returned exactly as
 * before, which is what makes this additive rather than a behavior change for
 * every caller.
 *
 * Why holding rather than delivering the verdict afterwards: the answer arrives
 * as the tool call's own RETURN VALUE. A tool result is not user text, so a
 * crafted approval can never be read as the operator's words — the prompt-
 * injection surface a steer or an injected message would open does not exist on
 * this path. `message-dispatcher.ts` refuses a steer into a turn parked on an
 * interaction for exactly that reason.
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

import type { ApprovalOrigin } from '@dorkos/shared/approval-schemas';

import type { AgentIdentity } from './agent-identity/agent-identity-service.js';
import { resolveApprovalSubject } from './approvals/index.js';
import { awaitCapabilityApproval, type CapabilityApprovalHold } from './capabilities/index.js';
import { approvalTokenArgument } from './capabilities/mcp-projection.js';
import {
  enforceCapabilityTier,
  isFreshApprovalAsk,
  splitApprovalToken,
  type ApprovalRequiredPayload,
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

/** One gated call, as {@link runGate} is asked to decide it. */
interface GateRun {
  /** The tool's tier declaration, from the shared table. */
  action: GatedAction;
  /** The arguments the SDK parsed for this call. */
  args: unknown;
  /** The calling agent, when the surface resolved one. */
  identity?: AgentIdentity;
  /** Whether the caller can be told to open the approval panel (DOR-1570). */
  interactive: boolean;
  /** Which surface the call arrived over, recorded for an unattributed card. */
  origin: ApprovalOrigin;
  /**
   * A token to present INSTEAD of one carried in `args`.
   *
   * The resume path only (DOR-1930). It rides beside the input rather than
   * inside it, so the arguments hashed on the resume are the same bytes the
   * person approved.
   */
  approvalToken?: string;
}

/**
 * What the gate concluded about one hand-registered tool call: either run the
 * handler with these arguments, or return this result instead.
 */
type GateOutcome =
  | { allowed: true; input: Record<string, unknown> }
  | {
      allowed: false;
      result: CallToolResult;
      /**
       * The approval this call just minted, when it minted one.
       *
       * Present only for a FRESH ask ({@link isFreshApprovalAsk}) — the one kind
       * of refusal a caller may wait on, because it is the one that created the
       * thing being waited for. An `awaiting_decision` echo of a card already on
       * screen, a ceiling denial, and a deny all leave this undefined and return
       * their payload unchanged.
       */
      fresh?: ApprovalRequiredPayload;
      /**
       * The arguments this pass hashed, already split from any token.
       *
       * Handed back so a resume re-presents the SAME input rather than
       * reconstructing it — the approval binds to a hash of these, so rebuilding
       * them is the one way the person could approve one thing and another run.
       */
      input: unknown;
    };

/**
 * Run the tier gate for one hand-registered tool call.
 *
 * The arguments hashed into the approval are exactly the arguments the handler
 * will receive, minus the approval token. There is no second parse between this
 * check and the call, which is what makes the binding cover what actually runs —
 * the registry path has to assert schema parse-idempotence to get the same
 * property, because it parses once more on the way in.
 *
 * @param run - The action, its arguments, and the surface it arrived on.
 * @returns Whether to proceed, and with what.
 */
async function runGate(run: GateRun): Promise<GateOutcome> {
  const { action, args, identity, interactive, origin } = run;
  // Only a destructive tool advertises `approvalToken`, so only a destructive call
  // has one to lift off. Anything else passes its arguments through untouched
  // rather than silently losing a field that happens to share the name.
  const split =
    action.tier === 'destructive'
      ? splitApprovalToken(args)
      : { approvalToken: undefined, input: args };
  const input = split.input;
  // A token supplied out-of-band wins over one carried in the arguments. That is
  // the resume path (below), and carrying it beside the input rather than
  // spreading it back INTO the input is what keeps the hashed arguments byte
  // identical across the two passes — the person approves exactly what runs.
  const approvalToken = run.approvalToken ?? split.approvalToken;

  // Named HERE rather than inside the gate because every registry that can name
  // an id is async and `enforceCapabilityTier` is not (DOR-1929). This is the
  // same reason, and the same shape, as awaiting the identity above.
  const subject = await resolveApprovalSubject(action.approvalSubject, input);

  const decision = enforceCapabilityTier({
    action,
    input,
    ...(identity ? { identity } : {}),
    ...(approvalToken ? { approvalToken } : {}),
    ...(subject ? { subject } : {}),
    origin,
    // An MCP client cannot set an HTTP header on a tool call, so the retry
    // instructions must name the tool ARGUMENT this module advertises.
    retryChannel: 'mcp-argument',
    // Wording only — see `TierEnforcementRequest.interactive`. The in-session
    // server can be told to open the panel for the operator; the external
    // `/mcp` server has no session and no `control_ui`, and the two entry
    // points below are what already tell those apart.
    interactive,
  });

  if (decision.outcome !== 'allowed') {
    const fresh =
      decision.outcome === 'approval_required' && isFreshApprovalAsk(decision.payload)
        ? decision.payload
        : undefined;
    return {
      allowed: false,
      result: textResult(decision.payload),
      input,
      ...(fresh ? { fresh } : {}),
    };
  }
  return { allowed: true, input: (input ?? {}) as Record<string, unknown> };
}

/**
 * The abort signal of the tool call, when the SDK handed one over.
 *
 * Read defensively because `extra` is typed `unknown` here on purpose — this
 * module is deliberately outside the runtime-SDK confinement rule, so it cannot
 * import the SDK's own shape. A missing signal costs only that a mid-turn
 * interrupt no longer ends a hold early; it still ends at the cap.
 *
 * @param extra - The second argument the SDK passes a tool handler.
 * @returns The signal, or `undefined`.
 */
function abortSignalOf(extra: unknown): AbortSignal | undefined {
  if (!extra || typeof extra !== 'object' || !('signal' in extra)) return undefined;
  const signal = (extra as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/** How {@link runGatedInSession} reaches the real handler, and what it may wait on. */
interface HandlerRun {
  /** Invokes the real handler with the gate-approved input. */
  invoke: (input: Record<string, unknown>) => Promise<CallToolResult>;
  /** The live session's hold seam, when this surface has one. */
  hold?: CapabilityApprovalHold;
  /** The SDK's second handler argument, read for an abort signal. */
  extra: unknown;
}

/**
 * Run one gated call, waiting for a person when there is a session to wait in.
 *
 * Three endings, and only the first is new:
 *
 * 1. **The person decides in time.** The gate is re-run with the granted token
 *    beside the input, so the SAME binding is checked and consumed that the
 *    person approved — never a second, unchecked path to the handler. A grant
 *    runs the tool and returns its real result; a denial returns the gate's
 *    refusal.
 * 2. **No decision before the cap** (`timeout`, `expired`). The original
 *    `approval_required` payload is returned verbatim — the exact poll flow this
 *    replaces, so a hold is never worse than not holding.
 * 3. **No hold at all**, or a refusal that minted nothing fresh. Unchanged.
 *
 * The retry carries the token as an ARGUMENT because that is the channel this
 * module advertises (`approvalTokenArgument`); `splitApprovalToken` lifts it
 * back off before the input is hashed, so the token cannot change the hash it is
 * checked against.
 *
 * @param call - The action, its arguments, and the surface it arrived on.
 * @param run - The handler to invoke, plus the hold seam and the SDK's `extra`.
 * @returns The tool result to hand back to the model.
 */
async function runGatedInSession(call: GateRun, run: HandlerRun): Promise<CallToolResult> {
  const outcome = await runGate(call);
  if (outcome.allowed) return run.invoke(outcome.input);
  if (!run.hold || !outcome.fresh) return outcome.result;

  const signal = abortSignalOf(run.extra);
  const decided = await awaitCapabilityApproval(
    { ...run.hold, ...(signal ? { signal } : {}) },
    outcome.fresh
  );
  // `timeout` and `expired` are not failures — they are the poll flow, which
  // still works: the card is on the dashboard and the agent still holds a token.
  if (decided !== 'granted' && decided !== 'denied') return outcome.result;

  // A full gate pass, not a shortcut around it. The token rides beside the SAME
  // input the first pass hashed, so the binding the person approved is the one
  // checked here — and a denial comes back as an ordinary refusal payload.
  //
  // "Goes through the gate" rather than "always spends the token": if the person
  // answered with "allow, and stop asking", the grant created a standing
  // permission, and the resume is allowed by THAT before the token is consulted.
  // The token then goes unspent, which is harmless — the permission already
  // licenses the action, and on this path the model never receives the token at
  // all. Shared with the registry path, not introduced here.
  const retried = await runGate({
    ...call,
    args: outcome.input,
    approvalToken: outcome.fresh.approvalToken,
  });
  return retried.allowed ? run.invoke(retried.input) : retried.result;
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
 * @param hold - The live session's hold seam, when this server has one. With it,
 *   a fresh destructive ask waits for the operator and resumes in the same turn
 *   (DOR-1930); without it the poll payload is returned exactly as before.
 * @returns The same tools, gated, with `approvalToken` advertised where required.
 * @throws If any tool declares no tier in `MCP_TOOL_TIERS`.
 */
export function gateHandRegisteredMcpTools<T extends SdkMcpTool>(
  tools: readonly T[],
  resolveContext?: () => Promise<{ identity?: AgentIdentity } | undefined>,
  hold?: CapabilityApprovalHold
): T[] {
  return tools.map((definition) => {
    const action = gatedActionForMcpTool(definition.name);
    const handler = definition.handler;
    return {
      ...definition,
      inputSchema: gatedInputSchema(action, definition.inputSchema),
      handler: async (args: never, extra: unknown): Promise<CallToolResult> => {
        // Resolved ONCE per call: the resolver memoizes per session, but reading
        // it twice here would still be two awaits for one fact.
        const identity = (await resolveContext?.())?.identity;
        return runGatedInSession(
          {
            action,
            args,
            ...(identity ? { identity } : {}),
            // `interactive: true` — this entry point wraps the IN-SESSION server,
            // where `control_ui` exists, so a gated call may be told to put the
            // approval in front of the operator (DOR-1570).
            interactive: true,
            origin: 'session',
          },
          {
            invoke: (input: Record<string, unknown>) => handler(input as never, extra),
            ...(hold ? { hold } : {}),
            extra,
          }
        );
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
        const outcome = await runGate({
          action,
          args,
          ...(identity ? { identity } : {}),
          // `interactive: false` — the external `/mcp` server is sessionless, so
          // the UI tools are not registered and must not be suggested.
          interactive: false,
          origin: 'external-mcp',
        });
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
