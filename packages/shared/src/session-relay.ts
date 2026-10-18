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
 * - holds a turn a relayed message started to the runtime's default level, so
 *   whatever the chat's own trust level, anything that needs a person waits
 *   for one (a hub or a Cloud that was broken into could have written the
 *   words), and never answers an approval over the relay without the signed
 *   proof (B4);
 * - verifies every approval proof itself (its own challenge, unexpired, used
 *   once, signed by the passkey it pinned) and refuses an approval without one;
 * - refuses a relayed question answer until it too carries the signed proof
 *   (B4): it puts words into a turn a person started at the chat's own level,
 *   which the turn ceiling on a relayed message does not reach;
 * - accepts a relayed message only as a queued turn of its own, never staged
 *   or steered into another turn, and never as a slash command, whose
 *   `allowed-tools` would approve tools ahead of time;
 * - decides what to allow from its own level and rules, never from the
 *   features it advertised or anything the web side says about the viewer;
 * - enforces {@link SESSION_RELAY_MAX_OPEN_STREAMS} and
 *   {@link SESSION_RELAY_MAX_INFLIGHT_REQUESTS}, takes one `hello` per
 *   connection, and ignores every request before a `welcome` that
 *   {@link isAgreedRelayVersion} accepts;
 * - records every relayed action in its own audit record.
 *
 * **Versions and proof.** The computer opens with `hello` naming the protocol
 * versions it speaks, the features it has and a fresh nonce; the web side
 * answers `welcome` with the one version both speak and its Ed25519 signature
 * over the whole exchange ({@link relayWelcomeTranscript}), or a signed `refuse` when there is no
 * common version. The computer verifies the signature with the key it pinned
 * from the hub itself at link time, so a compromised DorkOS Cloud that points
 * the computer elsewhere cannot answer. The relay credential on the dial
 * proves the computer to the hub; the signature proves the hub to the computer. A computer that lacks one
 * feature says so through {@link missingRelayFeature}, so the page can say
 * "this computer needs an update for X" instead of breaking.
 *
 * **Agent computers.** A cloud computer that runs a person's agents for their
 * hub speaks this same protocol, version and handshake, plus a few operations
 * of its own that only exist when both sides advertise them. They live in
 * `session-relay-agent-computer.ts`; nothing in this module serves them, so a
 * linked Mac stays chats only.
 *
 * Frame encoding mirrors `stream-socket.ts`: one JSON object per WebSocket text
 * frame, parsed fail-soft, so a bad frame is a dropped frame and never a torn
 * down connection.
 *
 * @module shared/session-relay
 */
import { z } from 'zod';
import type { AgentComputerFrame, AgentComputerWebFrame } from './session-relay-agent-computer.js';
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

/** The words of one relayed message: never empty, at most {@link SESSION_RELAY_MAX_MESSAGE_LENGTH}. */
export const RelayMessageContentSchema = z.string().min(1).max(SESSION_RELAY_MAX_MESSAGE_LENGTH);

/** Most streams one connection may hold open at once; the next is refused. */
export const SESSION_RELAY_MAX_OPEN_STREAMS = 32;

/** Most requests one connection may have unanswered at once; the next is refused. */
export const SESSION_RELAY_MAX_INFLIGHT_REQUESTS = 16;

/** Most chats one `chats.list` answer carries. */
export const SESSION_RELAY_MAX_CHATS = 200;

/**
 * How long a computer keeps the relay open after the web side reports no
 * viewers. An open relay keeps a hub awake, so it closes soon after the last
 * viewer leaves; the next `viewer_open` dials again.
 */
export const SESSION_RELAY_IDLE_CLOSE_MS = 3 * 60 * 1000;

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
export const RelayAdvertisedFeaturesSchema = z.array(z.string().min(1).max(64)).max(64);

// === Ids ===

/** Correlates one request with its one answer. Chosen by the web side. */
export const RelayRequestIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w.:-]+$/);

/** Names one open stream on the connection. Chosen by the web side. */
const StreamIdSchema = RelayRequestIdSchema;

/**
 * A chat on the computer: a lowercase UUID (as `SessionSchema.id` is minted),
 * so it can never smuggle a path segment into a URL, and two spellings of one
 * id cannot pass two different checks.
 */
export const RelaySessionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** A registered agent on the computer, by its Mesh id (a ULID). Never a directory. */
export const RelayAgentIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

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
  agentId: RelayAgentIdSchema,
});

/** Open a chat's durable stream, resuming after `resume` when given. */
const SessionStreamRequestSchema = z.strictObject({
  op: z.literal('session.stream'),
  streamId: StreamIdSchema,
  sessionId: RelaySessionIdSchema,
  resume: ResumeCursorSchema.optional(),
});

/**
 * Send a message. With `newChat`, the message starts a new chat with that agent
 * under `sessionId`; without it, a chat the computer does not know is refused,
 * never started.
 */
const SessionSendRequestSchema = z.strictObject({
  op: z.literal('session.send'),
  sessionId: RelaySessionIdSchema,
  content: RelayMessageContentSchema,
  clientMessageId: RelayRequestIdSchema.optional(),
  disposition: MessageDispositionSchema.optional(),
  newChat: z.strictObject({ agentId: RelayAgentIdSchema }).optional(),
});

/** Stop the chat's running turn and empty its queue, as the Stop button does. */
const SessionInterruptRequestSchema = z.strictObject({
  op: z.literal('session.interrupt'),
  sessionId: RelaySessionIdSchema,
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
  sessionId: RelaySessionIdSchema,
  toolCallId: ToolCallIdSchema,
  decision: ApprovalDecisionSchema,
});

/** A WebAuthn assertion over a challenge the computer issued, base64url fields. */
export const RelayApprovalProofSchema = z.strictObject({
  /** The `challengeId` the computer answered `interaction.challenge` with. */
  challengeId: RelayRequestIdSchema,
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
  sessionId: RelaySessionIdSchema,
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
  sessionId: RelaySessionIdSchema,
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
  'session.send': z.strictObject({ sessionId: RelaySessionIdSchema }),
  'session.interrupt': z.strictObject({
    receipt: InterruptReceiptSchema,
    cancelledQueued: z.array(QueuedMessageSchema),
  }),
  'interaction.challenge': z.strictObject({
    challengeId: RelayRequestIdSchema,
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
//
// A connection has two phases. The HANDSHAKE is plain JSON: the computer's
// `hello`, then the web side's `welcome` (or `refuse`). Both sides then derive
// keys from an X25519 exchange that the hub signed with the key the computer
// pinned, and every later frame travels SEALED: `{ type: 'sealed', seq, box }`,
// an AEAD box over one inner frame. So an attacker who can terminate TLS at the
// hub's address, or replay a handshake, can neither read nor inject a frame:
// the keys exist only on the computer and the hub that holds the pinned key.
// The sealing itself lives with the two ends (`apps/server`); this module
// fixes the shapes and the exact bytes that are signed.

/** Base64url of exactly `bytes` bytes, unpadded. */
const exactBase64url = (bytes: number) =>
  z
    .string()
    .length(Math.ceil((bytes * 4) / 3))
    .regex(/^[A-Za-z0-9_-]+$/);

/** An X25519 public key, raw 32 bytes. */
export const RelayEphemeralKeySchema = exactBase64url(32);

/** An Ed25519 signature, always 64 bytes. */
export const RelaySignatureSchema = exactBase64url(64);

/** A one-time value: 32 random bytes, a fresh one on every connection. */
export const RelayNonceSchema = exactBase64url(32);

/** The Ed25519 public key a computer pins from its hub, raw 32 bytes. */
export const RelayPinnedHubKeySchema = exactBase64url(32);

/**
 * The frame a computer opens with: which computer it is, what it can talk, a
 * fresh nonce and its half of the key exchange. The computer id is not a
 * claim the hub trusts: the computer proves it in its first sealed frame,
 * `finish`, signed with the key the hub pinned for that computer.
 */
export const RelayHelloFrameSchema = z.strictObject({
  type: z.literal('hello'),
  /** The computer's id as its hub knows it. Proved by `finish`, never taken on trust. */
  computerId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\w.:-]+$/),
  versions: RelayVersionRangeSchema,
  features: RelayAdvertisedFeaturesSchema,
  /** The computer's DorkOS version, for "needs an update" copy. */
  appVersion: z.string().min(1).max(64),
  nonce: RelayNonceSchema,
  ephemeralKey: RelayEphemeralKeySchema,
});

/** See {@link RelayHelloFrameSchema}. */
export type RelayHelloFrame = z.infer<typeof RelayHelloFrameSchema>;

/**
 * The web side's answer to `hello`. `welcome` names the agreed version and the
 * hub's half of the key exchange, signed over {@link relayWelcomeTranscript};
 * `refuse` names the versions the hub speaks, signed over
 * {@link relayRefuseTranscript}. A computer verifies either with the key it
 * pinned from the hub itself (never from DorkOS Cloud), and closes the
 * connection on anything it cannot verify, saying nothing about an update.
 */
export const RelayHandshakeAnswerSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('welcome'),
    version: VersionSchema,
    ephemeralKey: RelayEphemeralKeySchema,
    signature: RelaySignatureSchema,
  }),
  z.strictObject({
    type: z.literal('refuse'),
    versions: RelayVersionRangeSchema,
    signature: RelaySignatureSchema,
  }),
]);

/** See {@link RelayHandshakeAnswerSchema}. */
export type RelayHandshakeAnswer = z.infer<typeof RelayHandshakeAnswerSchema>;

/**
 * Every frame after the handshake, both ways: one inner frame sealed with the
 * sender's direction key. `seq` starts at 0 and rises by exactly 1 per frame
 * in each direction; a receiver drops the connection on any other.
 */
export const RelaySealedFrameSchema = z.strictObject({
  type: z.literal('sealed'),
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  box: z
    .string()
    .min(1)
    .max(SESSION_RELAY_MAX_FRAME_LENGTH)
    .regex(/^[A-Za-z0-9_-]+$/),
});

/** See {@link RelaySealedFrameSchema}. */
export type RelaySealedFrame = z.infer<typeof RelaySealedFrameSchema>;

/** Liveness, both ways. Resets the silence watchdog and carries nothing. */
const HeartbeatFrameSchema = z.strictObject({ type: z.literal('heartbeat') });

/**
 * What the web side sends inside a sealed frame: requests, closing a stream the
 * viewer no longer needs, its viewer count and liveness.
 */
export const RelayWebFrameSchema = z.discriminatedUnion('type', [
  /**
   * A request. Every `op` but `session.stream` is answered by exactly one
   * `result` or `error` with the same `id`; a stream is answered by its
   * `stream.frame`s and one `stream.end`, which carries the refusal if it never
   * opened.
   */
  z.strictObject({
    type: z.literal('request'),
    id: RelayRequestIdSchema,
    request: RelayRequestSchema,
  }),
  z.strictObject({ type: z.literal('stream.close'), streamId: StreamIdSchema }),
  /**
   * How many viewers have a chat of this computer open right now. At 0, and
   * from the moment the handshake ends until the first report, the computer
   * closes the relay after {@link SESSION_RELAY_IDLE_CLOSE_MS}.
   */
  z.strictObject({ type: z.literal('viewers'), count: z.number().int().min(0).max(10_000) }),
  HeartbeatFrameSchema,
]);

/** One inner frame from the web side to a computer. */
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
 * What a computer sends inside a sealed frame: one answer per request, stream
 * frames, the end of a stream, and liveness.
 */
export const RelayComputerFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('result'),
    id: RelayRequestIdSchema,
    ok: z.literal(true),
    body: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('error'),
    id: RelayRequestIdSchema,
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

/** One inner frame from a computer to the web side. */
export type RelayComputerFrame = z.infer<typeof RelayComputerFrameSchema>;

/**
 * The computer's first sealed frame: its Ed25519 signature, by the long-lived
 * key the hub pinned for this computer, over {@link relayFinishTranscript}.
 * The hub serves nothing until it verifies, so a stolen relay credential alone
 * cannot stand in for the computer.
 */
export const RelayFinishFrameSchema = z.strictObject({
  type: z.literal('finish'),
  signature: RelaySignatureSchema,
});

/** See {@link RelayFinishFrameSchema}. */
export type RelayFinishFrame = z.infer<typeof RelayFinishFrameSchema>;

// === Signed transcripts ===

/** The label every relay transcript starts with, so a signature means nothing elsewhere. */
export const SESSION_RELAY_TRANSCRIPT_LABEL = 'dorkos-session-relay/v1';

/** What a hub signs, and a computer checks, to settle one handshake. */
export interface RelayTranscriptInput {
  /** The `hello` exactly as it crossed the wire, text and all. */
  helloText: string;
  /** The hub's origin, as the computer pinned it (`https://…`, no path). */
  hubOrigin: string;
}

/**
 * The exact bytes a hub signs in `welcome`: the label, the whole `hello` as
 * sent, the hub's origin, the agreed version and the hub's ephemeral key, one
 * per line. Binding the whole `hello` covers the computer's id, nonce, key and
 * the versions it offered, so neither a replay, a downgrade nor a hello passed
 * on from another computer verifies.
 *
 * @param input - The `hello` text and the pinned origin.
 * @param version - The version the `welcome` names.
 * @param hubEphemeralKey - The `welcome`'s ephemeral key.
 */
export function relayWelcomeTranscript(
  input: RelayTranscriptInput,
  version: number,
  hubEphemeralKey: string
): Uint8Array {
  return transcript('welcome', input, [String(version), hubEphemeralKey]);
}

/**
 * The exact bytes a computer signs in `finish`: the same exchange as the
 * `welcome`, under its own line, so neither signature stands in for the other.
 *
 * @param input - The `hello` text and the pinned origin.
 * @param version - The agreed version.
 * @param hubEphemeralKey - The `welcome`'s ephemeral key.
 */
export function relayFinishTranscript(
  input: RelayTranscriptInput,
  version: number,
  hubEphemeralKey: string
): Uint8Array {
  return transcript('finish', input, [String(version), hubEphemeralKey]);
}

/**
 * The exact bytes a hub signs in `refuse`, so a computer only says "needs an
 * update" when its own hub said so.
 *
 * @param input - The `hello` text and the pinned origin.
 * @param versions - The versions the `refuse` names.
 */
export function relayRefuseTranscript(
  input: RelayTranscriptInput,
  versions: RelayVersionRange
): Uint8Array {
  return transcript('refuse', input, [`${versions.min}-${versions.max}`]);
}

function transcript(kind: string, input: RelayTranscriptInput, tail: string[]): Uint8Array {
  // One field per line: an origin with a line break in it could shift every
  // field after it, so it is refused rather than signed.
  if (/[\r\n]/.test(input.hubOrigin)) throw new Error('A hub origin cannot contain a line break');
  return new TextEncoder().encode(
    [SESSION_RELAY_TRANSCRIPT_LABEL, kind, input.hubOrigin, input.helloText, ...tail].join('\n')
  );
}

/**
 * Parse one frame, or `null` when it is too long, not JSON, or not a frame of
 * `schema`. Fails soft: a bad frame is dropped, the connection lives on.
 *
 * @param raw - The raw text frame received from the socket.
 * @param schema - The schema for what this side expects next: the handshake
 *   schemas first, then {@link RelaySealedFrameSchema}, and once opened,
 *   {@link RelayWebFrameSchema} on a computer or {@link RelayComputerFrameSchema}
 *   on the web side.
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
export function encodeRelayFrame(
  frame:
    | RelayWebFrame
    | RelayComputerFrame
    | AgentComputerWebFrame
    | AgentComputerFrame
    | RelayHelloFrame
    | RelayHandshakeAnswer
    | RelaySealedFrame
): string | null {
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
