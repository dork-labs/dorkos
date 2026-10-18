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
 *   the identity files named in {@link AGENT_COMPUTER_IDENTITY_FILES} and
 *   nothing else, and its package list), or removes it;
 * - `turn.start` starts a turn for an agent and names it. The hub decides the
 *   turn's origin, tier, permission mode and outsider cap from its own
 *   records; the computer runs what it is told. **The computer enforces the
 *   permission mode and the outsider cap on its own local tools** (the shell,
 *   files), which never reach the hub's gate; the hub enforces the same record
 *   on every DorkOS tool the turn calls (part 5 builds the computer's side).
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
 * **What the computer is comes from the hub's records, never from `hello`.**
 * The hub decodes a connection's frames with {@link AgentComputerFrameSchema},
 * and sends it {@link hubFeaturesFrameFor} at all, only when its own proven
 * record of that computer (made when it was linked, and checked by the
 * computer's `finish` signature) says it is an agent computer. Features in
 * `hello` only narrow what a known agent computer is asked: a linked Mac that
 * advertised `tools.call` is still a Mac, decoded with
 * `RelayComputerFrameSchema`, and a `call` from it closes its connection.
 *
 * **Sizes are measured, never trusted.** No field here carries a length the
 * receiver believes: names and ids are capped in characters, identity files
 * and every opaque JSON value are measured in UTF-8 bytes of their own
 * serialization (opaque JSON before it is parsed, and no deeper than
 * {@link AGENT_COMPUTER_MAX_JSON_DEPTH}), and every list has a most. A value
 * past its cap is refused with its whole frame, never truncated, because a
 * tool input cut short is a different tool call and a tool output cut short
 * is a different answer; a tool that wants to say less shortens its own text.
 *
 * **Every legal frame can be sent.** On top of the field caps, each large body
 * (`agents.sync`, `turn.start`, `tools.call` both ways, `tools.list`) is held
 * to {@link AGENT_COMPUTER_MAX_BODY_BYTES}, which leaves room for its frame
 * inside `SESSION_RELAY_MAX_INNER_FRAME_BYTES`, the most one sealed frame
 * carries. So a value these schemas accept always encodes and seals. A sender
 * still checks before it sends ({@link encodeRelayCallFrame},
 * {@link encodeRelayCallResultFrame}, {@link encodeAgentComputerRequestFrame}),
 * because a frame the receiver cannot decode closes the whole connection, and
 * with it every agent's turns on that computer. A hub that reads a `call` it
 * cannot decode answers it through {@link readRelayCallId} instead of closing.
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
import { CONVENTION_FILES } from './convention-files.js';
import { PermissionModeSchema } from './schemas.js';
import {
  JsonObjectSchema,
  JsonValueSchema,
  jsonByteLength,
  withJsonBounds,
} from './bounded-json.js';
import {
  RelayAdvertisedFeaturesSchema,
  RelayAgentIdSchema,
  RelayComputerFrameSchema,
  RelayErrorSchema,
  RelayMessageContentSchema,
  RelayRequestIdSchema,
  RelaySessionIdSchema,
  RelayWebFrameSchema,
  SESSION_RELAY_MAX_FRAME_LENGTH,
  SESSION_RELAY_MAX_INNER_FRAME_BYTES,
  encodeRelayFrame,
  type RelayError,
} from './session-relay.js';

// === Limits ===

/** Most serialized UTF-8 bytes of an agent's manifest in `agents.sync`. */
export const AGENT_COMPUTER_MAX_MANIFEST_BYTES = 64 * 1024;

/**
 * The only files `agents.sync` may carry: an agent's identity files, by exact
 * name, from `CONVENTION_FILES` (the agent's soul, its limits, its memory and
 * its heartbeat checklist). Nothing else in an agent's folder ever travels: no
 * `.env`, no keys, no connector tokens, no relay pin, no `agent.json` (which
 * rides as `manifest`), and no workspace file, which lives on the computer
 * already. The hub reads only these names from the agent's folder.
 */
export const AGENT_COMPUTER_IDENTITY_FILES = [
  CONVENTION_FILES.soul,
  CONVENTION_FILES.nope,
  CONVENTION_FILES.memory,
  CONVENTION_FILES.heartbeat,
] as const;

/**
 * The only `agent.json` fields `agents.sync` carries: who the agent is and how
 * it behaves. Everything that can hold or point at a secret stays on the hub:
 * `mcpServers` (whose connections carry `env` and `headers`), `account` (which
 * account a session bills), `permissions` (the hub's gate reads them, the
 * computer never decides by them), `workspace` (a path on the hub), and the
 * registration bookkeeping. A field added to `agent.json` reaches a computer
 * only once somebody adds it here.
 */
export const AGENT_COMPUTER_MANIFEST_FIELDS = [
  'id',
  'name',
  'displayName',
  'description',
  'runtime',
  'capabilities',
  'behavior',
  'namespace',
  'persona',
  'personaEnabled',
  'traits',
  'conventions',
  'color',
  'icon',
  'isSystem',
  'model',
  'effort',
] as const;

const MANIFEST_FIELDS: ReadonlySet<string> = new Set(AGENT_COMPUTER_MANIFEST_FIELDS);

/**
 * An `agent.json` cut to what an agent computer may hold
 * ({@link AGENT_COMPUTER_MANIFEST_FIELDS}). The hub builds every `agents.sync`
 * manifest with this; the schema refuses one that was not.
 *
 * @param manifest - The agent's `agent.json`, as the hub reads it.
 */
export function agentComputerManifestOf(
  manifest: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(manifest).filter(([key]) => MANIFEST_FIELDS.has(key)));
}

/** One identity file name. See {@link AGENT_COMPUTER_IDENTITY_FILES}. */
export type AgentComputerIdentityFile = (typeof AGENT_COMPUTER_IDENTITY_FILES)[number];

/** Most identity files one `agents.sync` carries: each allowed name once. */
export const AGENT_COMPUTER_MAX_IDENTITY_FILES = AGENT_COMPUTER_IDENTITY_FILES.length;

/** Most UTF-8 bytes of one identity file's text, as serialized. Larger is refused, never cut. */
export const AGENT_COMPUTER_MAX_IDENTITY_FILE_BYTES = 64 * 1024;

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

/** Deepest nesting of any opaque JSON value here; the top level is depth 0. */
export const AGENT_COMPUTER_MAX_JSON_DEPTH = 32;

/**
 * Most UTF-8 bytes of one large body (a request, a call, or a call's answer)
 * as serialized: what one sealed frame carries, less room for the frame
 * around it. Field caps alone do not add up to a frame, so every large body
 * is also held to this, and a body these schemas accept always seals.
 */
export const AGENT_COMPUTER_MAX_BODY_BYTES = SESSION_RELAY_MAX_INNER_FRAME_BYTES - 256;

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

/** One identity file: exactly one of {@link AGENT_COMPUTER_IDENTITY_FILES}, case and all. */
const IdentityFileNameSchema = z.enum(AGENT_COMPUTER_IDENTITY_FILES);

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

/** A JSON value, measured in bytes and depth before it is parsed. */
const boundedJsonValue = (maxBytes: number) =>
  withJsonBounds(JsonValueSchema, { maxBytes, maxDepth: AGENT_COMPUTER_MAX_JSON_DEPTH });

/** A JSON object, measured in bytes and depth before it is parsed. */
const boundedJsonObject = (maxBytes: number) =>
  withJsonBounds(JsonObjectSchema, { maxBytes, maxDepth: AGENT_COMPUTER_MAX_JSON_DEPTH });

const TOO_LARGE = 'Too large to send in one frame';

/** Whether a parsed body fits {@link AGENT_COMPUTER_MAX_BODY_BYTES}. */
const fitsOneFrame = (body: unknown) => jsonByteLength(body) <= AGENT_COMPUTER_MAX_BODY_BYTES;

/** Identity file text, measured in bytes as serialized (escapes included). */
const IdentityFileTextSchema = z
  .string()
  // Every character serializes to at least one byte: a cheap first cut.
  .max(AGENT_COMPUTER_MAX_IDENTITY_FILE_BYTES)
  .refine((text) => jsonByteLength(text) <= AGENT_COMPUTER_MAX_IDENTITY_FILE_BYTES, {
    message: 'Identity file is too large',
  });

// === Requests (hub to computer) ===

/** Replace one agent's identity copy on the computer. */
const AgentsSyncPutSchema = z
  .strictObject({
    op: z.literal('agents.sync'),
    agentId: RelayAgentIdSchema,
    /**
     * The agent's `agent.json`, cut to {@link AGENT_COMPUTER_MANIFEST_FIELDS}
     * by {@link agentComputerManifestOf}. Any other top-level field refuses
     * the whole frame.
     */
    manifest: boundedJsonObject(AGENT_COMPUTER_MAX_MANIFEST_BYTES).refine(
      (manifest) => Object.keys(manifest).every((key) => MANIFEST_FIELDS.has(key)),
      { message: 'The manifest carries a field an agent computer never gets' }
    ),
    files: z
      .array(
        z.strictObject({
          name: IdentityFileNameSchema,
          text: IdentityFileTextSchema,
        })
      )
      .max(AGENT_COMPUTER_MAX_IDENTITY_FILES),
    packages: z.array(PackageRefSchema).max(AGENT_COMPUTER_MAX_PACKAGES),
  })
  .refine((sync) => new Set(sync.files.map((file) => file.name)).size === sync.files.length, {
    message: 'Each identity file is named once',
  })
  .refine(fitsOneFrame, { message: TOO_LARGE });

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

/**
 * Start a turn for an agent. Carries the same words a `session.send` does. A
 * turn from a room, task or beat names which one; a chat turn needs no
 * reference, because its session is the chat.
 */
const TurnStartRequestSchema = z
  .strictObject({
    op: z.literal('turn.start'),
    agentId: RelayAgentIdSchema,
    sessionId: RelaySessionIdSchema,
    content: RelayMessageContentSchema,
    origin: AgentComputerTurnOriginSchema,
    /** The room, task or beat the turn came from, by the hub's own id. */
    originRef: RelayRequestIdSchema.optional(),
    tier: AgentComputerTurnTierSchema,
    /**
     * The permission mode the turn runs at, as the hub decided it. The
     * computer holds its own local tools (the shell, files) to it: the hub
     * gates only the DorkOS tools it runs itself.
     */
    permissionMode: PermissionModeSchema,
    /**
     * Whether the turn read words DorkOS cannot vouch for (a stranger's
     * message, or a turn that read one), so it runs capped. The computer holds
     * its local tools to the cap as the hub holds its own tools.
     */
    outsiderCapped: z.boolean(),
  })
  .refine((turn) => turn.origin === 'chat' || turn.originRef !== undefined, {
    message: 'A room, task or beat turn names where it came from',
  })
  .refine(fitsOneFrame, { message: TOO_LARGE });

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

/**
 * The answer body for each agent-computer request. A `turnId` is chosen by the
 * computer: the hub may show or log it, but keys its own record of the turn by
 * its own ids and never trusts a `turnId` to be unique or to name a turn the
 * hub started.
 */
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
  z
    .strictObject({
      op: z.literal('tools.call'),
      agentId: RelayAgentIdSchema,
      sessionId: RelaySessionIdSchema,
      tool: ToolNameSchema,
      input: boundedJsonValue(AGENT_COMPUTER_MAX_TOOL_INPUT_BYTES),
    })
    .refine(fitsOneFrame, { message: TOO_LARGE }),
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

/**
 * One tool in a `tools.list` answer. Strict, so a field added here is a whole
 * `tools.list` an older computer refuses: a new field needs a new feature id,
 * sent only to a computer that advertised it.
 */
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
    output: boundedJsonValue(AGENT_COMPUTER_MAX_TOOL_OUTPUT_BYTES),
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
  /**
   * Each tool is capped, and the list as a whole fits one frame. A hub with
   * more to show than fits chooses which tools to list; it never sends a list
   * that cannot be read.
   */
  'tools.list': z
    .strictObject({
      tools: z.array(RelayToolSummarySchema).max(AGENT_COMPUTER_MAX_TOOLS),
    })
    .refine(fitsOneFrame, { message: TOO_LARGE }),
  'tools.call': RelayToolCallOutcomeSchema.refine(fitsOneFrame, { message: TOO_LARGE }),
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
 * Just enough of a `call` to answer it: its type and id, and nothing else
 * checked. Deliberately loose; never read anything but the id from it.
 */
const RelayCallEnvelopeSchema = z.object({ type: z.literal('call'), id: CallIdSchema });

/**
 * The id of an inner frame that is a `call` but not one the hub can decode
 * (too large, malformed, an op it does not know), or `null` when it is not a
 * `call` at all. The hub answers such a call with a refusing `call.result`
 * ({@link relayCallRefusalFrame}) rather than closing the connection, which
 * would end every agent's turns on that computer. It may: the sealed frame
 * opened, so the sequence is intact; only the inner frame was refused. Any
 * other undecodable frame still closes the connection.
 *
 * For an agent computer's connection only. A linked Mac never sends a `call`,
 * so one arriving from a Mac still closes its connection.
 *
 * @param innerText - The opened inner frame's text.
 */
export function readRelayCallId(innerText: string): string | null {
  if (innerText.length > SESSION_RELAY_MAX_FRAME_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(innerText);
  } catch {
    return null;
  }
  const envelope = RelayCallEnvelopeSchema.safeParse(parsed);
  return envelope.success ? envelope.data.id : null;
}

/** A refusal for a frame too large to send or receive. */
const RELAY_TOO_LARGE: RelayError = {
  status: 413,
  code: 'invalid',
  message: 'That is too large to send over the relay.',
};

/** A refusal for a frame that is not well formed. */
const RELAY_MALFORMED: RelayError = {
  status: 400,
  code: 'invalid',
  message: 'That is not a request the relay can carry.',
};

/** A refusal for an answer the hub built in a shape its `op` does not define. */
const RELAY_BAD_ANSWER: RelayError = {
  status: 500,
  code: 'internal',
  message: 'DorkOS could not answer that call.',
};

/** Whether a schema issue is a size cap, as opposed to a wrong shape. */
function isTooLargeIssue(issue: z.core.$ZodIssue): boolean {
  // A plain union reports one wrapping issue; the size refusal sits inside it.
  if (issue.code === 'invalid_union') {
    return issue.errors.some((branch) => branch.some(isTooLargeIssue));
  }
  return issue.code === 'too_big' || /too large|byte limit/i.test(issue.message);
}

/**
 * The refusing `call.result` for one call id: what a hub answers a call it
 * cannot decode or will not serve.
 *
 * @param id - The call's id.
 * @param error - Why it was refused.
 */
export function relayCallRefusalFrame(id: string, error: RelayError): RelayCallResultFrame {
  return { type: 'call.result', id, ok: false, error };
}

/** What a checked encode produced: the text to seal, or why there is none. */
export type CheckedRelayEncode = { ok: true; text: string } | { ok: false; error: RelayError };

/**
 * Check `frame` against `schema` and encode it, or say why it cannot go out:
 * 413 when it is too large (a field, its body or the frame), 400 when it is
 * otherwise malformed. Run on every agent-computer frame before it is sealed,
 * so the sender fails the one operation locally instead of sending a frame the
 * receiver closes the connection on.
 *
 * @param schema - The schema the receiver will decode the frame with.
 * @param frame - The frame about to be sent.
 */
export function encodeCheckedRelayFrame(
  schema: z.ZodType<AgentComputerWebFrame | AgentComputerFrame>,
  frame: AgentComputerWebFrame | AgentComputerFrame
): CheckedRelayEncode {
  const parsed = schema.safeParse(frame);
  if (!parsed.success) {
    const tooLarge = parsed.error.issues.some(isTooLargeIssue);
    return { ok: false, error: tooLarge ? RELAY_TOO_LARGE : RELAY_MALFORMED };
  }
  const text = encodeRelayFrame(frame);
  return text === null ? { ok: false, error: RELAY_TOO_LARGE } : { ok: true, text };
}

/**
 * Encode one call, or the refusal the computer fails its tool with locally.
 *
 * @param id - A call id this connection has not used.
 * @param call - The call.
 */
export function encodeRelayCallFrame(id: string, call: RelayCall): CheckedRelayEncode {
  return encodeCheckedRelayFrame(RelayCallFrameSchema, { type: 'call', id, call });
}

/**
 * Encode the hub's answer to one call. A body the computer could not read
 * (too large, or not the shape its `op` defines) is never sent: the computer
 * gets a refusing `call.result` for the same id instead, so the call still
 * ends and the connection stays open.
 *
 * @param id - The call's id.
 * @param op - The call's `op`.
 * @param body - The answer body.
 */
export function encodeRelayCallResultFrame(
  id: string,
  op: RelayCallFeature,
  body: unknown
): string {
  const checked = RelayCallResultBodySchemas[op].safeParse(body);
  const frame: RelayCallResultFrame = checked.success
    ? { type: 'call.result', id, ok: true, body }
    : relayCallRefusalFrame(
        id,
        // Not too large means the hub built a wrong answer: its own fault.
        checked.error.issues.some(isTooLargeIssue) ? RELAY_TOO_LARGE : RELAY_BAD_ANSWER
      );
  // A refusal is a few hundred bytes, so it always encodes.
  return encodeRelayFrame(frame) ?? encodeRelayFrame(relayCallRefusalFrame(id, RELAY_TOO_LARGE))!;
}

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

/**
 * Encode one hub-to-computer request, or the refusal the hub answers its own
 * caller with, so an `agents.sync` or a turn too large to carry fails on the
 * hub instead of closing the computer's connection.
 *
 * @param id - A request id this connection has not used.
 * @param request - The request.
 */
export function encodeAgentComputerRequestFrame(
  id: string,
  request: AgentComputerRequest
): CheckedRelayEncode {
  return encodeCheckedRelayFrame(AgentComputerWebFrameSchema, { type: 'request', id, request });
}

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
 * understand the frame never receives it. Called only for a connection the
 * hub's own records say is an agent computer, never on the strength of
 * `hello` (see the module comment).
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
