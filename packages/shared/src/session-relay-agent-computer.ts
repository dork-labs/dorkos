/**
 * The session relay's operations for agent computers (spec
 * `everything-is-a-space`, design note `design-agent-computers.md` §2, step
 * A7 part 3).
 *
 * An agent computer is a sealed cloud computer that runs a person's agents for
 * their hub. It dials in exactly as a linked Mac does (`session-relay.ts`: the
 * same version, handshake, signatures and sealed frames) and serves the same
 * chat operations, plus the ones here. The protocol stays at version 1: every
 * operation below is a feature, and it travels only when both sides
 * advertised it, so a peer that does not know it keeps today's behaviour. An
 * old peer closes the connection on a frame it cannot parse, so these frames
 * are never sent "just in case".
 *
 * **Hub to computer**, as `request` frames answered by one `result` or
 * `error`, like the chat operations:
 *
 * - `agents.sync` pushes one agent's read-only identity copy (its manifest,
 *   identity files such as `SOUL.md` and its package list), or removes it;
 * - `turn.start` starts a turn for an agent and names it. The hub decides the
 *   turn's origin and tier from its own records; the computer runs what it is
 *   told.
 *
 * The computer advertises these two in `hello`, from
 * {@link AGENT_COMPUTER_RELAY_FEATURES}; the hub sends one only when
 * {@link missingAgentComputerFeature} says the computer has it.
 *
 * **Computer to hub**, which the chat operations never needed: two new frame
 * types with their own id space, sealed like every other frame. The computer
 * sends `call`; the hub answers each with exactly one `call.result`.
 *
 * - `tools.list`: which DorkOS tools an agent may see now;
 * - `tools.call`: run one DorkOS tool as that agent, in that session;
 * - `computer.status`: busy or idle, and the turns it is running.
 *
 * Both sides advertise these. The computer names the ones it may ask in
 * `hello`; the hub answers, only when the computer named at least one, with
 * one sealed `features` frame naming the ones it serves
 * ({@link hubFeaturesFrameFor}). The computer asks only what both named
 * ({@link negotiatedRelayCallFeatures}, {@link missingRelayCallFeature}), and
 * treats the hub as serving none until that frame arrives; the hub refuses any
 * other call with `needs_update`.
 *
 * **Sizes are measured, never trusted.** No field here carries a length the
 * receiver believes: every string is capped in characters, every opaque JSON
 * value is measured in UTF-8 bytes of its own serialization before it is
 * parsed, and every list has a most. A value past its cap makes the whole
 * frame refused, never truncated, because a tool input cut short is a
 * different tool call and a tool output cut short is a different answer. The
 * one exception is a tool's own text, which a tool that wants to say less
 * shortens itself. On top of every cap, a frame longer than
 * `SESSION_RELAY_MAX_FRAME_LENGTH` is dropped.
 *
 * **What the hub must still do (parts 5 and 6).** The shapes say only what is
 * well formed. The hub checks that each call's agent works on this
 * connection's proven computer and that its session is one the hub started for
 * that agent; it takes the tier from its own record of the turn, never from
 * the computer; it runs every tool through its own permission gate as that
 * agent; and it never reads `computer.status` as anything but a report.
 *
 * @module shared/session-relay-agent-computer
 */
import { z } from 'zod';
import { RecursiveJsonSchema, boundedJson } from './canvas-channel-json.js';
import {
  RelayAdvertisedFeaturesSchema,
  RelayAgentIdSchema,
  RelayComputerFrameSchema,
  RelayErrorSchema,
  RelayMessageContentSchema,
  RelayRequestIdSchema,
  RelaySessionIdSchema,
  RelayWebFrameSchema,
  type RelayError,
} from './session-relay.js';

// === Limits ===

/** Most serialized UTF-8 bytes of an agent's manifest in `agents.sync`. */
export const AGENT_COMPUTER_MAX_MANIFEST_BYTES = 64 * 1024;

/** Most identity files one `agents.sync` carries. */
export const AGENT_COMPUTER_MAX_IDENTITY_FILES = 8;

/** Longest identity file, in characters. Longer is refused, never cut. */
export const AGENT_COMPUTER_MAX_IDENTITY_FILE_LENGTH = 64_000;

/** Most packages one `agents.sync` lists. */
export const AGENT_COMPUTER_MAX_PACKAGES = 200;

/** Most turns one `computer.status` reports. */
export const AGENT_COMPUTER_MAX_TURNS = 64;

/** Most tools one `tools.list` answer carries. */
export const AGENT_COMPUTER_MAX_TOOLS = 256;

/** Most serialized UTF-8 bytes of one tool's input schema in `tools.list`. */
export const AGENT_COMPUTER_MAX_TOOL_SCHEMA_BYTES = 16 * 1024;

/** Most serialized UTF-8 bytes of a `tools.call` input. Larger is refused, never cut. */
export const AGENT_COMPUTER_MAX_TOOL_INPUT_BYTES = 256 * 1024;

/** Most serialized UTF-8 bytes of a `tools.call` output. Larger is refused, never cut. */
export const AGENT_COMPUTER_MAX_TOOL_OUTPUT_BYTES = 512 * 1024;

// === Features ===

/**
 * The operations only an agent computer and its hub speak, one feature each.
 * A linked Mac advertises none of them, so it never receives one.
 */
export const AGENT_COMPUTER_RELAY_FEATURES = [
  'agents.sync',
  'turn.start',
  'tools.list',
  'tools.call',
  'computer.status',
] as const;

/** One agent-computer feature id. See {@link AGENT_COMPUTER_RELAY_FEATURES}. */
export type AgentComputerRelayFeature = (typeof AGENT_COMPUTER_RELAY_FEATURES)[number];

/** The features a computer asks its hub for; the hub serves them. */
export const RELAY_CALL_FEATURES = ['tools.list', 'tools.call', 'computer.status'] as const;

/** One computer-to-hub feature. See {@link RELAY_CALL_FEATURES}. */
export type RelayCallFeature = (typeof RELAY_CALL_FEATURES)[number];

// === Shared pieces ===

/** A DorkOS tool, by the name its capability registers. Never a path. */
const ToolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][\w.-]*$/);

/** One identity file, such as `SOUL.md` or `NOPE.md`: a bare Markdown file name, no folder. */
const IdentityFileNameSchema = z
  .string()
  .max(68)
  .regex(/^[A-Za-z0-9][\w-]{0,63}\.md$/);

/** An installed package, as the marketplace names and versions it. */
const PackageRefSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(214)
    .regex(/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/),
  version: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\w.+-]+$/),
});

/** A JSON object, measured in bytes before it is parsed. */
const boundedJsonObject = (maxBytes: number) =>
  boundedJson(z.object({}).catchall(RecursiveJsonSchema), maxBytes);

// === Requests (hub to computer) ===

/** Replace one agent's identity copy on the computer. */
const AgentsSyncPutSchema = z
  .strictObject({
    op: z.literal('agents.sync'),
    agentId: RelayAgentIdSchema,
    /** The agent's `agent.json`, opaque to the relay. */
    manifest: boundedJsonObject(AGENT_COMPUTER_MAX_MANIFEST_BYTES),
    files: z
      .array(
        z.strictObject({
          name: IdentityFileNameSchema,
          text: z.string().max(AGENT_COMPUTER_MAX_IDENTITY_FILE_LENGTH),
        })
      )
      .max(AGENT_COMPUTER_MAX_IDENTITY_FILES),
    packages: z.array(PackageRefSchema).max(AGENT_COMPUTER_MAX_PACKAGES),
  })
  .refine((sync) => new Set(sync.files.map((file) => file.name)).size === sync.files.length, {
    message: 'Each identity file is named once',
  });

/** Remove one agent's identity copy from the computer. */
const AgentsSyncRemoveSchema = z.strictObject({
  op: z.literal('agents.sync'),
  agentId: RelayAgentIdSchema,
  remove: z.literal(true),
});

/** Where a turn came from, as the hub recorded it. */
export const AgentComputerTurnOriginSchema = z.enum(['chat', 'room', 'task', 'beat']);

/** The tier the hub runs a turn at. The computer never decides it. */
export const AgentComputerTurnTierSchema = z.enum(['owner', 'teammate']);

/** Start a turn for an agent. Carries the same words a `session.send` does. */
const TurnStartRequestSchema = z.strictObject({
  op: z.literal('turn.start'),
  agentId: RelayAgentIdSchema,
  sessionId: RelaySessionIdSchema,
  content: RelayMessageContentSchema,
  origin: AgentComputerTurnOriginSchema,
  /** The room, task or beat the turn came from, by the hub's own id. */
  originRef: RelayRequestIdSchema.optional(),
  tier: AgentComputerTurnTierSchema,
});

/**
 * Every request only a hub sends to its agent computer. Not part of
 * `RelayRequestSchema`, so a linked Mac never parses one.
 */
export const AgentComputerRequestSchema = z.union([
  AgentsSyncPutSchema,
  AgentsSyncRemoveSchema,
  TurnStartRequestSchema,
]);

/** One agent-computer request. See {@link AgentComputerRequestSchema}. */
export type AgentComputerRequest = z.infer<typeof AgentComputerRequestSchema>;

/** The answer body for each agent-computer request. */
export const AgentComputerResultBodySchemas = {
  'agents.sync': z.strictObject({ agentId: RelayAgentIdSchema }),
  'turn.start': z.strictObject({ sessionId: RelaySessionIdSchema, turnId: RelayRequestIdSchema }),
} as const;

/** The `op`s of {@link AgentComputerRequest}. */
export type AgentComputerRequestOp = keyof typeof AgentComputerResultBodySchemas;

/** The parsed `result` body for an agent-computer `op`. */
export type AgentComputerResultBody<Op extends AgentComputerRequestOp> = z.infer<
  (typeof AgentComputerResultBodySchemas)[Op]
>;

/**
 * Check a `result` body against the agent-computer `op` the hub asked, or
 * `null` when it does not match.
 *
 * @param op - The `op` of the request the result answers.
 * @param body - The `body` of the `result` frame.
 */
export function parseAgentComputerResult<Op extends AgentComputerRequestOp>(
  op: Op,
  body: unknown
): AgentComputerResultBody<Op> | null {
  const result = AgentComputerResultBodySchemas[op].safeParse(body);
  return result.success ? (result.data as AgentComputerResultBody<Op>) : null;
}

// === Calls (computer to hub) ===

/** Correlates one call with its one `call.result`. Chosen by the computer, apart from request ids. */
const CallIdSchema = RelayRequestIdSchema;

/** Every call a computer can make, discriminated on `op`. */
export const RelayCallSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('tools.list'),
    agentId: RelayAgentIdSchema,
    sessionId: RelaySessionIdSchema,
  }),
  z.strictObject({
    op: z.literal('tools.call'),
    agentId: RelayAgentIdSchema,
    sessionId: RelaySessionIdSchema,
    tool: ToolNameSchema,
    input: boundedJson(RecursiveJsonSchema, AGENT_COMPUTER_MAX_TOOL_INPUT_BYTES),
  }),
  z
    .strictObject({
      op: z.literal('computer.status'),
      busy: z.boolean(),
      turns: z
        .array(z.strictObject({ agentId: RelayAgentIdSchema, sessionId: RelaySessionIdSchema }))
        .max(AGENT_COMPUTER_MAX_TURNS),
    })
    .refine((status) => status.busy || status.turns.length === 0, {
      message: 'An idle computer runs no turns',
    }),
]);

/** One call from a computer to its hub. See {@link RelayCallSchema}. */
export type RelayCall = z.infer<typeof RelayCallSchema>;

/** One tool in a `tools.list` answer. */
export const RelayToolSummarySchema = z.strictObject({
  name: ToolNameSchema,
  description: z.string().max(4_000),
  inputSchema: boundedJsonObject(AGENT_COMPUTER_MAX_TOOL_SCHEMA_BYTES),
});

/** See {@link RelayToolSummarySchema}. */
export type RelayToolSummary = z.infer<typeof RelayToolSummarySchema>;

/**
 * A tool's answer: its output, or why it failed. A failed tool is still an
 * answer, so it rides an `ok` `call.result`; a `call.result` error means the
 * call itself was refused (a missing feature, a bad frame, the wrong agent).
 */
export const RelayToolCallOutcomeSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    /** JSON, or a plain string for text. */
    output: boundedJson(RecursiveJsonSchema, AGENT_COMPUTER_MAX_TOOL_OUTPUT_BYTES),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[\w.:-]+$/),
    message: z.string().max(1_000),
  }),
]);

/** See {@link RelayToolCallOutcomeSchema}. */
export type RelayToolCallOutcome = z.infer<typeof RelayToolCallOutcomeSchema>;

/** The answer body for each call `op`. */
export const RelayCallResultBodySchemas = {
  'tools.list': z.strictObject({
    tools: z.array(RelayToolSummarySchema).max(AGENT_COMPUTER_MAX_TOOLS),
  }),
  'tools.call': RelayToolCallOutcomeSchema,
  'computer.status': z.strictObject({ ok: z.literal(true) }),
} as const;

/** The parsed `call.result` body for a call `op`. */
export type RelayCallResultBody<Op extends RelayCallFeature> = z.infer<
  (typeof RelayCallResultBodySchemas)[Op]
>;

/**
 * Check a `call.result` body against the `op` the computer asked, or `null`
 * when it does not match.
 *
 * @param op - The `op` of the call the result answers.
 * @param body - The `body` of the `call.result` frame.
 */
export function parseRelayCallResult<Op extends RelayCallFeature>(
  op: Op,
  body: unknown
): RelayCallResultBody<Op> | null {
  const result = RelayCallResultBodySchemas[op].safeParse(body);
  return result.success ? (result.data as RelayCallResultBody<Op>) : null;
}

// === Frames ===

/**
 * The hub's one advertisement of the calls it serves, sealed like every
 * frame after the handshake. Sent once, right after the computer proves
 * itself, and only to a computer whose `hello` named a call feature.
 */
export const RelayFeaturesFrameSchema = z.strictObject({
  type: z.literal('features'),
  features: RelayAdvertisedFeaturesSchema,
});

/** See {@link RelayFeaturesFrameSchema}. */
export type RelayFeaturesFrame = z.infer<typeof RelayFeaturesFrameSchema>;

/** The hub's answer to one call: exactly one per `call` id. */
export const RelayCallResultFrameSchema = z.union([
  z.strictObject({
    type: z.literal('call.result'),
    id: CallIdSchema,
    ok: z.literal(true),
    body: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('call.result'),
    id: CallIdSchema,
    ok: z.literal(false),
    error: RelayErrorSchema,
  }),
]);

/** See {@link RelayCallResultFrameSchema}. */
export type RelayCallResultFrame = z.infer<typeof RelayCallResultFrameSchema>;

/** A call from the computer. Answered by one {@link RelayCallResultFrameSchema}. */
export const RelayCallFrameSchema = z.strictObject({
  type: z.literal('call'),
  id: CallIdSchema,
  call: RelayCallSchema,
});

/** See {@link RelayCallFrameSchema}. */
export type RelayCallFrame = z.infer<typeof RelayCallFrameSchema>;

/**
 * What a hub sends an agent computer inside a sealed frame: every web frame a
 * Mac takes, plus the agent-computer requests, the features advertisement and
 * call answers. An agent computer decodes with this; a Mac keeps
 * `RelayWebFrameSchema`.
 */
export const AgentComputerWebFrameSchema = z.union([
  RelayWebFrameSchema,
  z.strictObject({
    type: z.literal('request'),
    id: RelayRequestIdSchema,
    request: AgentComputerRequestSchema,
  }),
  RelayFeaturesFrameSchema,
  RelayCallResultFrameSchema,
]);

/** One inner frame from a hub to its agent computer. */
export type AgentComputerWebFrame = z.infer<typeof AgentComputerWebFrameSchema>;

/**
 * What an agent computer sends its hub inside a sealed frame: every computer
 * frame a Mac sends, plus calls. The hub decodes an agent computer's frames
 * with this, and a Mac's with `RelayComputerFrameSchema`.
 */
export const AgentComputerFrameSchema = z.union([RelayComputerFrameSchema, RelayCallFrameSchema]);

/** One inner frame from an agent computer to its hub. */
export type AgentComputerFrame = z.infer<typeof AgentComputerFrameSchema>;

// === Negotiation ===

/**
 * The agent-computer feature a hub-to-computer request needs, or `null` when
 * the computer advertised it.
 *
 * @param advertised - The features the computer sent in `hello`.
 * @param request - The request about to be sent.
 */
export function missingAgentComputerFeature(
  advertised: readonly string[],
  request: AgentComputerRequest
): AgentComputerRelayFeature | null {
  return advertised.includes(request.op) ? null : request.op;
}

/**
 * The calls both sides advertised: the only ones a computer may send and a
 * hub may serve. On the hub, `computer` is the `hello`; on the computer,
 * `hub` is the `features` frame, and an empty list until it arrives.
 *
 * @param computer - The features the computer advertised in `hello`.
 * @param hub - The features the hub advertised in its `features` frame.
 */
export function negotiatedRelayCallFeatures(
  computer: readonly string[],
  hub: readonly string[]
): RelayCallFeature[] {
  return RELAY_CALL_FEATURES.filter(
    (feature) => computer.includes(feature) && hub.includes(feature)
  );
}

/**
 * The feature a call needs that was not negotiated, or `null` when both sides
 * advertised it.
 *
 * @param negotiated - From {@link negotiatedRelayCallFeatures}.
 * @param call - The call about to be sent, or just received.
 */
export function missingRelayCallFeature(
  negotiated: readonly string[],
  call: RelayCall
): RelayCallFeature | null {
  return negotiated.includes(call.op) ? null : call.op;
}

/**
 * The refusal a hub answers a call with when its feature was not negotiated,
 * or `null` when it was. A newer computer reads it as "the hub needs an
 * update for" that feature.
 *
 * @param negotiated - From {@link negotiatedRelayCallFeatures}.
 * @param call - The call the computer sent.
 */
export function relayCallFeatureRefusal(
  negotiated: readonly string[],
  call: RelayCall
): RelayError | null {
  const feature = missingRelayCallFeature(negotiated, call);
  if (feature === null) return null;
  return {
    status: 501,
    code: 'needs_update',
    message: 'This DorkOS does not serve that call yet.',
    feature,
  };
}

/**
 * The `features` frame a hub sends after a computer proves itself, or `null`
 * when the computer named no call feature, so a computer that would not
 * understand the frame never receives it.
 *
 * @param computer - The features the computer advertised in `hello`.
 * @param hub - The calls this hub serves.
 */
export function hubFeaturesFrameFor(
  computer: readonly string[],
  hub: readonly RelayCallFeature[]
): RelayFeaturesFrame | null {
  if (!RELAY_CALL_FEATURES.some((feature) => computer.includes(feature))) return null;
  return { type: 'features', features: [...hub] };
}
