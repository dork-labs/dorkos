/**
 * The session relay protocol: how a person's own DorkOS on the web reaches the
 * chats on one of their computers (ADR 261015-042933 rules 4 and 5, spec
 * `everything-is-a-space` step B1).
 *
 * The computer dials out. It opens ONE WebSocket to the address and key it
 * pinned when its owner turned the relay on, and every viewer the web side has
 * open rides that one connection as numbered requests and streams. Nothing here
 * names an address to dial: a "a viewer is open" wake carries none, so a
 * computer only ever reaches what it pinned. The relay credential travels on
 * the dial itself, never in a frame, so no frame can claim to be anyone.
 *
 * **Chats only, and nothing else.** The protocol carries listing an agent's
 * chats, the durable session stream (snapshot, resume from a cursor, live
 * `seq`), sending a message, approvals, question answers and interrupt.
 * Terminal, files, settings, connections and previews are never relayed; they
 * open as a page move to the computer's own remote address, behind its own
 * login. The shapes enforce what they can:
 *
 * - every object is strict, so a field this module does not name (`cwd`,
 *   `agentPath`, `runtime`, `account`, `permissionMode`, `seedContext`,
 *   `alwaysAllow`) is a refused frame rather than a silently ignored one;
 * - every id is a narrow pattern (a lowercase UUID, a ULID, a frame id), so no
 *   request can carry a path segment or a query string into a URL the computer
 *   builds from it;
 * - an approval approves once or denies, and only with a passkey proof bound
 *   to that exact decision (spec step B4). "Always allow" changes the
 *   computer's rules, which is full control, so it has no field here. MCP
 *   elicitations are not relayed: their URL mode is a sign-in, which is a
 *   connection.
 *
 * **What the computer must still do (step B2).** Who the caller is belongs to
 * the computer, not to the protocol. The computer:
 *
 * - treats everything arriving over this connection as a relayed caller, its
 *   own kind in the session gate, never "at this computer" and never a person;
 * - serves only person-facing chats of registered agents, in `chats.list` and
 *   in every request naming a session (never a room turn, a task run or a
 *   heartbeat), whatever UUID a request names;
 * - marks a turn a relayed message started as relayed, so a tool call that
 *   needs a person waits for a signed approval instead of being allowed by
 *   the computer's own trust level;
 * - verifies every approval proof itself (its own challenge, unexpired, used
 *   once, signed by the passkey it pinned) and refuses an approval without one;
 * - takes a relayed question answer as having no more power than a relayed
 *   message: it is words for the agent, not a person's decision;
 * - decides what to allow from its own level and rules, never from the
 *   features it advertised or anything the web side says about the viewer;
 * - enforces {@link SESSION_RELAY_MAX_OPEN_STREAMS} and
 *   {@link SESSION_RELAY_MAX_INFLIGHT_REQUESTS}, takes one `hello` per
 *   connection, and ignores every request before a `welcome` that
 *   {@link isAgreedRelayVersion} accepts;
 * - records every relayed action in its own audit record.
 *
 * **Versions.** The computer opens with `hello` naming the protocol versions it
 * speaks and the features it has; the web side answers `welcome` with the one
 * version both speak, or `refuse` when there is none. A computer that lacks one
 * feature says so through {@link missingRelayFeature}, so the page can say
 * "this computer needs an update for X" instead of breaking.
 *
 * Frame encoding mirrors `stream-socket.ts`: one JSON object per WebSocket text
 * frame, parsed fail-soft, so a bad frame is a dropped frame and never a torn
 * down connection.
 *
 * @module shared/session-relay
 */
import { z } from 'zod';
import {
  DENY_REASON_MAX_LENGTH,
  InterruptReceiptSchema,
  MessageDispositionSchema,
  QueuedMessageSchema,
} from './schemas.js';

// === Versions and limits ===

/**
 * The protocol versions this build speaks, oldest first. Two peers agree on
 * the highest version both speak ({@link negotiateRelayVersion}), so a hostile
 * peer can only ever force the lowest one this build accepts. Raise `max` for
 * an additive change, and raise `min` the moment an old version is unsafe, not
 * only when it can no longer be served.
 */
export const SESSION_RELAY_VERSIONS = { min: 1, max: 1 } as const;

/**
 * Longest frame either side accepts, in UTF-16 code units (up to about three
 * times as many bytes on the wire). Larger is dropped. A socket's own byte
 * limit must sit above that, or an oversized frame closes the connection
 * instead of being dropped.
 */
export const SESSION_RELAY_MAX_FRAME_LENGTH = 1_048_576;

/** Longest message a relayed sender may post, in characters. */
export const SESSION_RELAY_MAX_MESSAGE_LENGTH = 200_000;

/** Most streams one connection may hold open at once; the next is refused. */
export const SESSION_RELAY_MAX_OPEN_STREAMS = 32;

/** Most requests one connection may have unanswered at once; the next is refused. */
export const SESSION_RELAY_MAX_INFLIGHT_REQUESTS = 16;

/** Most chats one `chats.list` answer carries. */
export const SESSION_RELAY_MAX_CHATS = 200;

const VersionSchema = z.number().int().positive();

/** A closed range of protocol versions a peer speaks. */
export const RelayVersionRangeSchema = z
  .strictObject({ min: VersionSchema, max: VersionSchema })
  .refine((range) => range.min <= range.max, { message: 'min must not exceed max' });

/** See {@link RelayVersionRangeSchema}. */
export type RelayVersionRange = z.infer<typeof RelayVersionRangeSchema>;

// === Features ===

/**
 * Everything a relayed caller can ask a computer to do, one feature per kind of
 * request. A computer advertises the ones it has in `hello`; a request for one
 * it lacks is refused before it is sent, naming the feature.
 */
export const SESSION_RELAY_FEATURES = [
  'chats.list',
  'session.stream',
  'session.send',
  'session.interrupt',
  'interaction.approval',
  'interaction.question',
] as const;

/** One feature id. See {@link SESSION_RELAY_FEATURES}. */
export type SessionRelayFeature = (typeof SESSION_RELAY_FEATURES)[number];

/**
 * A peer's advertised features. Plain strings rather than the enum, so a newer
 * peer's feature this build has never heard of is carried, not refused.
 */
const AdvertisedFeaturesSchema = z.array(z.string().min(1).max(64)).max(64);

// === Ids ===

/** Correlates one request with its one answer. Chosen by the web side. */
const RequestIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w.:-]+$/);

/** Names one open stream on the connection. Chosen by the web side. */
const StreamIdSchema = RequestIdSchema;

/**
 * A chat on the computer: a lowercase UUID (as `SessionSchema.id` is minted),
 * so it can never smuggle a path segment into a URL, and two spellings of one
 * id cannot pass two different checks.
 */
const SessionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** A registered agent on the computer, by its Mesh id (a ULID). Never a directory. */
const AgentIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

/** A tool call a chat is waiting on, as its runtime named it. */
const ToolCallIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w.:-]+$/);

/**
 * A durable stream's resume cursor: the whole `id` of the last frame the viewer
 * saw (`<sessionId>-<epoch>-<generation>-<seq>`, see `stream-socket.ts`),
 * never a bare `seq`, and never anything that could extend a query string.
 */
const ResumeCursorSchema = z
  .string()
  .max(256)
  .regex(/^[0-9a-f-]+-\d+-g\d+-\d+$/);

/** Base64url text, as WebAuthn encodes binary fields. */
const base64url = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);

// === Requests (web side to computer) ===

/** List an agent's chats, newest first. Titles and times only, never a path. */
const ChatsListRequestSchema = z.strictObject({
  op: z.literal('chats.list'),
  agentId: AgentIdSchema,
});

/** Open a chat's durable stream, resuming after `resume` when given. */
const SessionStreamRequestSchema = z.strictObject({
  op: z.literal('session.stream'),
  streamId: StreamIdSchema,
  sessionId: SessionIdSchema,
  resume: ResumeCursorSchema.optional(),
});

/**
 * Send a message. With `newChat`, the message starts a new chat with that agent
 * under `sessionId`; without it, a chat the computer does not know is refused,
 * never started.
 */
const SessionSendRequestSchema = z.strictObject({
  op: z.literal('session.send'),
  sessionId: SessionIdSchema,
  content: z.string().min(1).max(SESSION_RELAY_MAX_MESSAGE_LENGTH),
  clientMessageId: RequestIdSchema.optional(),
  disposition: MessageDispositionSchema.optional(),
  newChat: z.strictObject({ agentId: AgentIdSchema }).optional(),
});

/** Stop the chat's running turn and empty its queue, as the Stop button does. */
const SessionInterruptRequestSchema = z.strictObject({
  op: z.literal('session.interrupt'),
  sessionId: SessionIdSchema,
});

/** The decision an approval challenge is bound to. */
const ApprovalDecisionSchema = z.enum(['approve', 'deny']);

/**
 * Ask the computer for a one-time challenge to sign before answering an
 * approval. The computer binds it to this session, tool call and decision, a
 * hash of the exact tool input it holds, and a value of its own (spec B4).
 */
const InteractionChallengeRequestSchema = z.strictObject({
  op: z.literal('interaction.challenge'),
  sessionId: SessionIdSchema,
  toolCallId: ToolCallIdSchema,
  decision: ApprovalDecisionSchema,
});

/** A WebAuthn assertion over a challenge the computer issued, base64url fields. */
export const RelayApprovalProofSchema = z.strictObject({
  /** The `challengeId` the computer answered `interaction.challenge` with. */
  challengeId: RequestIdSchema,
  credentialId: base64url(1_400),
  clientDataJSON: base64url(4_096),
  authenticatorData: base64url(1_024),
  signature: base64url(512),
  userHandle: base64url(128).optional(),
});

/** See {@link RelayApprovalProofSchema}. */
export type RelayApprovalProof = z.infer<typeof RelayApprovalProofSchema>;

/**
 * Answer what a chat is waiting on. An approval needs a proof; there is
 * deliberately no "always allow" (see the module comment). A question answer
 * is words for the agent and needs none.
 */
const InteractionAnswerSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('approve'),
    toolCallId: ToolCallIdSchema,
    proof: RelayApprovalProofSchema,
  }),
  z.strictObject({
    kind: z.literal('deny'),
    toolCallId: ToolCallIdSchema,
    reason: z.string().max(DENY_REASON_MAX_LENGTH).optional(),
    proof: RelayApprovalProofSchema,
  }),
  z.strictObject({
    kind: z.literal('answer'),
    toolCallId: ToolCallIdSchema,
    answers: z.record(z.string().regex(/^\d{1,3}$/), z.string().max(10_000)),
  }),
]);

/** See {@link InteractionAnswerSchema}. */
export type RelayInteractionAnswer = z.infer<typeof InteractionAnswerSchema>;

const InteractionRespondRequestSchema = z.strictObject({
  op: z.literal('interaction.respond'),
  sessionId: SessionIdSchema,
  answer: InteractionAnswerSchema,
});

/** Every request a relayed caller can make, discriminated on `op`. */
export const RelayRequestSchema = z.discriminatedUnion('op', [
  ChatsListRequestSchema,
  SessionStreamRequestSchema,
  SessionSendRequestSchema,
  SessionInterruptRequestSchema,
  InteractionChallengeRequestSchema,
  InteractionRespondRequestSchema,
]);

/** One relayed request. See {@link RelayRequestSchema}. */
export type RelayRequest = z.infer<typeof RelayRequestSchema>;

/** The `op` names of {@link RelayRequest}. */
export type RelayRequestOp = RelayRequest['op'];

// === Results (computer to web side) ===

/** One chat in a `chats.list` answer: what a sidebar row needs, and no path. */
export const RelayChatSummarySchema = z.strictObject({
  sessionId: SessionIdSchema,
  title: z.string().max(500),
  updatedAt: z.string().datetime(),
  lastMessagePreview: z.string().max(500).optional(),
});

/** See {@link RelayChatSummarySchema}. */
export type RelayChatSummary = z.infer<typeof RelayChatSummarySchema>;

/** The answer body for each request `op` that answers with one `result`. */
export const RelayResultBodySchemas = {
  'chats.list': z.strictObject({
    chats: z.array(RelayChatSummarySchema).max(SESSION_RELAY_MAX_CHATS),
  }),
  'session.send': z.strictObject({ sessionId: SessionIdSchema }),
  'session.interrupt': z.strictObject({
    receipt: InterruptReceiptSchema,
    cancelledQueued: z.array(QueuedMessageSchema),
  }),
  'interaction.challenge': z.strictObject({
    challengeId: RequestIdSchema,
    /** The bytes to sign, base64url. Opaque to the web side. */
    challenge: base64url(256),
    /** When the computer stops accepting a proof over it. */
    expiresAt: z.string().datetime(),
  }),
  'interaction.respond': z.strictObject({ ok: z.boolean() }),
} as const;

/** The `op`s answered by one `result` (a stream answers with frames instead). */
export type RelayResultOp = keyof typeof RelayResultBodySchemas;

/** The parsed `result` body for `op`. */
export type RelayResultBody<Op extends RelayResultOp> = z.infer<
  (typeof RelayResultBodySchemas)[Op]
>;

/**
 * Check a `result` body against the `op` the web side asked for, or `null`
 * when it does not match. The web side tracks which `op` each request id was,
 * and reads every body through this, never as `unknown`.
 *
 * @param op - The `op` of the request the result answers.
 * @param body - The `body` of the `result` frame.
 */
export function parseRelayResult<Op extends RelayResultOp>(
  op: Op,
  body: unknown
): RelayResultBody<Op> | null {
  const result = RelayResultBodySchemas[op].safeParse(body);
  return result.success ? (result.data as RelayResultBody<Op>) : null;
}

/**
 * Why a request was refused. A string rather than an enum, so a newer peer's
 * reason reads as a refusal on an older one; these are the ones this version
 * sends.
 */
export const SESSION_RELAY_ERROR_CODES = [
  /** The computer lacks the feature; `feature` names it. */
  'needs_update',
  /** The frame did not parse as a request this version knows. */
  'invalid',
  /** No such chat or agent on the computer, or not one the relay serves. */
  'not_found',
  /** The computer's own rules refused it (level, login, a missing proof). */
  'refused',
  /** Too many open streams or unanswered requests on this connection. */
  'rate_limited',
  /** Something failed on the computer. */
  'internal',
] as const;

/** One known error code. See {@link SESSION_RELAY_ERROR_CODES}. */
export type SessionRelayErrorCode = (typeof SESSION_RELAY_ERROR_CODES)[number];

/** A refusal. `status` is the HTTP status the same refusal has locally. */
export const RelayErrorSchema = z.strictObject({
  status: z.number().int().min(400).max(599),
  code: z.string().min(1).max(64),
  message: z.string().max(1_000),
  feature: z.string().min(1).max(64).optional(),
});

/** See {@link RelayErrorSchema}. */
export type RelayError = z.infer<typeof RelayErrorSchema>;

// === Frames ===

/** The frame a computer opens with: what it can talk, never who it is. */
const HelloFrameSchema = z.strictObject({
  type: z.literal('hello'),
  versions: RelayVersionRangeSchema,
  features: AdvertisedFeaturesSchema,
  /** The computer's DorkOS version, for "needs an update" copy. */
  appVersion: z.string().min(1).max(64),
});

/** Liveness, both ways. Resets the silence watchdog and carries nothing. */
const HeartbeatFrameSchema = z.strictObject({ type: z.literal('heartbeat') });

/**
 * Frames the web side sends: the handshake answer, requests, and closing a
 * stream the viewer no longer needs.
 */
export const RelayWebFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('welcome'), version: VersionSchema }),
  z.strictObject({ type: z.literal('refuse'), versions: RelayVersionRangeSchema }),
  /**
   * A request. Every `op` but `session.stream` is answered by exactly one
   * `result` or `error` with the same `id`; a stream is answered by its
   * `stream.frame`s and one `stream.end`, which carries the refusal if it never
   * opened.
   */
  z.strictObject({ type: z.literal('request'), id: RequestIdSchema, request: RelayRequestSchema }),
  z.strictObject({ type: z.literal('stream.close'), streamId: StreamIdSchema }),
  HeartbeatFrameSchema,
]);

/** One frame from the web side to a computer. */
export type RelayWebFrame = z.infer<typeof RelayWebFrameSchema>;

/**
 * One frame of a durable session stream, as `stream-socket.ts` carries it:
 * `event` is the event name, `data` its payload, `id` the resume cursor.
 */
const RelayStreamFrameSchema = z.strictObject({
  event: z.string().min(1).max(100),
  data: z.unknown().optional(),
  id: ResumeCursorSchema.optional(),
});

/**
 * Frames a computer sends: the handshake, one answer per request, stream
 * frames, and the end of a stream.
 */
export const RelayComputerFrameSchema = z.discriminatedUnion('type', [
  HelloFrameSchema,
  z.strictObject({
    type: z.literal('result'),
    id: RequestIdSchema,
    ok: z.literal(true),
    body: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('error'),
    id: RequestIdSchema,
    ok: z.literal(false),
    error: RelayErrorSchema,
  }),
  z.strictObject({
    type: z.literal('stream.frame'),
    streamId: StreamIdSchema,
    frame: RelayStreamFrameSchema,
  }),
  z.strictObject({
    type: z.literal('stream.end'),
    streamId: StreamIdSchema,
    error: RelayErrorSchema.optional(),
  }),
  HeartbeatFrameSchema,
]);

/** One frame from a computer to the web side. */
export type RelayComputerFrame = z.infer<typeof RelayComputerFrameSchema>;

/**
 * Parse one frame, or `null` when it is too long, not JSON, or not a frame of
 * `schema`. Fails soft: a bad frame is dropped, the connection lives on.
 *
 * @param raw - The raw text frame received from the socket.
 * @param schema - {@link RelayWebFrameSchema} on a computer,
 *   {@link RelayComputerFrameSchema} on the web side.
 */
export function decodeRelayFrame<S extends z.ZodType>(raw: string, schema: S): z.infer<S> | null {
  if (raw.length > SESSION_RELAY_MAX_FRAME_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Serialize one frame for the wire, or `null` when it cannot be (too long for
 * the peer to read, or not serializable at all, such as nested past the
 * engine's stack). The sender answers with an error instead.
 *
 * @param frame - The frame to encode.
 */
export function encodeRelayFrame(frame: RelayWebFrame | RelayComputerFrame): string | null {
  let text: string;
  try {
    text = JSON.stringify(frame);
  } catch {
    return null;
  }
  return text.length > SESSION_RELAY_MAX_FRAME_LENGTH ? null : text;
}

// === Handshake ===

/** What {@link negotiateRelayVersion} decided. */
export type RelayVersionOutcome =
  | { ok: true; version: number }
  /** `outdated` names which side has to update: this build, or its peer. */
  | { ok: false; outdated: 'self' | 'peer' };

/**
 * Agree on the highest protocol version both sides speak.
 *
 * With no overlap, the side whose newest version is older than the other's
 * oldest is the one that needs an update. On the web side, `peer` is the
 * computer: "this computer needs an update".
 *
 * @param self - The versions this build speaks.
 * @param peer - The versions the other side advertised.
 */
export function negotiateRelayVersion(
  self: RelayVersionRange,
  peer: RelayVersionRange
): RelayVersionOutcome {
  const version = Math.min(self.max, peer.max);
  if (version >= Math.max(self.min, peer.min)) return { ok: true, version };
  return { ok: false, outdated: peer.max < self.min ? 'peer' : 'self' };
}

/**
 * Whether a `welcome` names a version this build speaks. A computer closes the
 * connection on any other, before it serves a single request.
 *
 * @param self - The versions this build speaks.
 * @param version - The version the `welcome` named.
 */
export function isAgreedRelayVersion(self: RelayVersionRange, version: number): boolean {
  return Number.isInteger(version) && version >= self.min && version <= self.max;
}

/**
 * The feature a request needs.
 *
 * @param request - The request about to be sent.
 */
export function relayFeatureFor(request: RelayRequest): SessionRelayFeature {
  switch (request.op) {
    case 'interaction.challenge':
      return 'interaction.approval';
    case 'interaction.respond':
      return request.answer.kind === 'answer' ? 'interaction.question' : 'interaction.approval';
    default:
      return request.op;
  }
}

/**
 * The feature a computer lacks for `request`, or `null` when it has it.
 *
 * A hint for the page, which shows "this computer needs an update for" the
 * feature rather than sending a request that would fail. It is never a
 * permission: the computer decides what to allow from its own rules, whatever
 * it advertised.
 *
 * @param advertised - The features the computer sent in `hello`.
 * @param request - The request about to be sent.
 */
export function missingRelayFeature(
  advertised: readonly string[],
  request: RelayRequest
): SessionRelayFeature | null {
  const feature = relayFeatureFor(request);
  return advertised.includes(feature) ? null : feature;
}
