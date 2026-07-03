/**
 * Recorded OpenCode SSE event fixtures + fake event-stream helpers for the
 * event-mapper (and later facade) tests.
 *
 * Mirrors the conventions of the Codex adapter's `codex-scenarios.ts`: typed
 * event builders, full scripted turns, and async-generator stream fakes. The
 * shapes are scripted against the `@opencode-ai/sdk` v1.17.13 generated types
 * and cross-checked against the upstream server source at that tag
 * (`anomalyco/opencode`, `packages/opencode/src/session/{processor,session,
 * status,run-state}.ts`) — see `event-mapper.ts` module docs for the wire
 * evidence. Lives inside the opencode ESLint boundary: `@opencode-ai/sdk`
 * imports are confined to `services/runtimes/opencode/`, so do not import
 * this module from outside the opencode adapter.
 *
 * The "fake SSE server" here is deliberately just an async generator yielding
 * fixture event objects — the real SDK's `.stream` yields parsed event
 * objects the same way, and the `opencode` binary must never be required by
 * tests (spec §Mocking).
 *
 * @module services/runtimes/opencode/__tests__/opencode-sse-fixtures
 */
import type {
  AssistantMessage,
  Event,
  GlobalEvent,
  Message,
  Part,
  Permission,
  ReasoningPart,
  Session,
  SessionStatus,
  TextPart,
  Todo,
  ToolPart,
  ToolState,
  UserMessage,
} from '@opencode-ai/sdk';
import type { EventMessagePartDelta, OpenCodeWireEvent } from '../event-mapper.js';

/** Directory both scripted sessions live in (proves sessionID-level demux). */
export const DIRECTORY = '/projects/alpha';
/** A second directory for directory-level demux assertions. */
export const OTHER_DIRECTORY = '/projects/beta';
/** OpenCode-native session ids (`ses_*` — NOT DorkOS UUIDs; see session-mapper). */
export const OC_SESSION_A = 'ses_alpha0001';
export const OC_SESSION_B = 'ses_beta0002';

/** Deterministic timestamps so tests can assert exact event payloads. */
export const CREATED_AT = 1_720_000_000_000;
export const COMPLETED_AT = 1_720_000_009_000;

/** Default assistant token usage for completed-message fixtures. */
export const DEFAULT_TOKENS: AssistantMessage['tokens'] = {
  input: 120,
  output: 45,
  reasoning: 10,
  cache: { read: 80, write: 12 },
};

/** Default turn cost (USD) for completed-message fixtures. */
export const DEFAULT_COST = 0.0042;

// === Part builders ===

/** Build a `text` part carrying the CUMULATIVE text seen so far. */
export function textPart(
  sessionID: string,
  id: string,
  text: string,
  opts: { messageID?: string; end?: boolean; ignored?: boolean } = {}
): TextPart {
  const { messageID = 'msg_0001', end = false, ignored } = opts;
  return {
    id,
    sessionID,
    messageID,
    type: 'text',
    text,
    ...(ignored !== undefined ? { ignored } : {}),
    time: { start: CREATED_AT, ...(end ? { end: COMPLETED_AT } : {}) },
  };
}

/** Build a `reasoning` part (cumulative text snapshot, like text). */
export function reasoningPart(
  sessionID: string,
  id: string,
  text: string,
  opts: { messageID?: string; end?: boolean } = {}
): ReasoningPart {
  const { messageID = 'msg_0001', end = false } = opts;
  return {
    id,
    sessionID,
    messageID,
    type: 'reasoning',
    text,
    time: { start: CREATED_AT, ...(end ? { end: COMPLETED_AT } : {}) },
  };
}

/** Build a `tool` part in the given state. */
export function toolPart(
  sessionID: string,
  callID: string,
  tool: string,
  state: ToolState,
  opts: { id?: string; messageID?: string } = {}
): ToolPart {
  const { id = `prt_${callID}`, messageID = 'msg_0001' } = opts;
  return { id, sessionID, messageID, type: 'tool', callID, tool, state };
}

/** Tool state: input still streaming — the mapper emits nothing for it. */
export function toolStatePending(input: Record<string, unknown> = {}): ToolState {
  return { status: 'pending', input, raw: JSON.stringify(input) };
}

/** Tool state: executing with the finalized input. */
export function toolStateRunning(input: Record<string, unknown>): ToolState {
  return { status: 'running', input, time: { start: CREATED_AT } };
}

/** Tool state: finished successfully with output. */
export function toolStateCompleted(
  input: Record<string, unknown>,
  output: string,
  title = 'tool run'
): ToolState {
  return {
    status: 'completed',
    input,
    output,
    title,
    metadata: {},
    time: { start: CREATED_AT, end: COMPLETED_AT },
  };
}

/** Tool state: failed with an error message. */
export function toolStateError(input: Record<string, unknown>, error: string): ToolState {
  return { status: 'error', input, error, time: { start: CREATED_AT, end: COMPLETED_AT } };
}

// === Message builders ===

/** Build an assistant message; `completed: true` stamps `time.completed` + usage. */
export function assistantMessage(
  sessionID: string,
  opts: {
    id?: string;
    completed?: boolean;
    tokens?: AssistantMessage['tokens'];
    cost?: number;
    modelID?: string;
  } = {}
): AssistantMessage {
  const {
    id = 'msg_0001',
    completed = false,
    tokens = DEFAULT_TOKENS,
    cost = DEFAULT_COST,
    modelID = 'claude-sonnet-4-5',
  } = opts;
  return {
    id,
    sessionID,
    role: 'assistant',
    time: { created: CREATED_AT, ...(completed ? { completed: COMPLETED_AT } : {}) },
    parentID: 'msg_0000',
    modelID,
    providerID: 'anthropic',
    mode: 'build',
    path: { cwd: DIRECTORY, root: DIRECTORY },
    cost,
    tokens,
  };
}

/** Build a user message (never mapped — exercises the role guard). */
export function userMessage(sessionID: string, id = 'msg_0000'): UserMessage {
  return {
    id,
    sessionID,
    role: 'user',
    time: { created: CREATED_AT },
    agent: 'build',
    model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
  };
}

// === Event builders ===

/** Wrap a part in a `message.part.updated` event (cumulative snapshot). */
export function partUpdated(part: Part, delta?: string): Event {
  return {
    type: 'message.part.updated',
    properties: { part, ...(delta !== undefined ? { delta } : {}) },
  };
}

/**
 * Build a `message.part.delta` WIRE event — the true text increment stream.
 * Undeclared by the SDK's Event union but published by the v1.17.13 server on
 * every `text-delta`/`reasoning-delta` (see event-mapper.ts module docs).
 */
export function partDelta(
  sessionID: string,
  partID: string,
  delta: string,
  opts: { messageID?: string; field?: string } = {}
): EventMessagePartDelta {
  const { messageID = 'msg_0001', field = 'text' } = opts;
  return { type: 'message.part.delta', properties: { sessionID, messageID, partID, field, delta } };
}

/** Wrap a message in a `message.updated` event. */
export function messageUpdated(info: Message): Event {
  return { type: 'message.updated', properties: { info } };
}

/** Build a `Permission` payload. */
export function permission(
  sessionID: string,
  opts: {
    id?: string;
    type?: string;
    pattern?: string | string[];
    callID?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  } = {}
): Permission {
  const {
    id = 'per_0001',
    type = 'bash',
    pattern,
    callID,
    title = 'Run command: rm -rf dist',
    metadata = { command: 'rm -rf dist' },
  } = opts;
  return {
    id,
    type,
    ...(pattern !== undefined ? { pattern } : {}),
    sessionID,
    messageID: 'msg_0001',
    ...(callID !== undefined ? { callID } : {}),
    title,
    metadata,
    time: { created: CREATED_AT },
  };
}

/** Wrap a Permission in a `permission.updated` event. */
export function permissionUpdated(perm: Permission): Event {
  return { type: 'permission.updated', properties: perm };
}

/** Build a `permission.replied` event (resolution echo, possibly from the TUI). */
export function permissionReplied(
  sessionID: string,
  permissionID: string,
  response = 'once'
): Event {
  return { type: 'permission.replied', properties: { sessionID, permissionID, response } };
}

/** Build a `session.status` event. */
export function statusEvent(sessionID: string, status: SessionStatus): Event {
  return { type: 'session.status', properties: { sessionID, status } };
}

/** Build the `session.idle` turn-terminal event. */
export function sessionIdle(sessionID: string): Event {
  return { type: 'session.idle', properties: { sessionID } };
}

/** Build a `session.compacted` event. */
export function sessionCompacted(sessionID: string): Event {
  return { type: 'session.compacted', properties: { sessionID } };
}

/** Build a `session.error` event; omit `error` to exercise the payload-less shape. */
export function sessionError(
  sessionID: string | undefined,
  error?: NonNullable<Extract<Event, { type: 'session.error' }>['properties']['error']>
): Event {
  return {
    type: 'session.error',
    properties: {
      ...(sessionID !== undefined ? { sessionID } : {}),
      ...(error !== undefined ? { error } : {}),
    },
  };
}

/** The abort shape: interrupting a turn surfaces `MessageAbortedError`. */
export function abortedError(message = 'The message was aborted') {
  return { name: 'MessageAbortedError' as const, data: { message } };
}

/** A generic unknown error payload. */
export function unknownError(message: string) {
  return { name: 'UnknownError' as const, data: { message } };
}

/** A provider auth failure payload. */
export function providerAuthError(providerID = 'anthropic', message = 'invalid api key') {
  return { name: 'ProviderAuthError' as const, data: { providerID, message } };
}

/** An output-length error payload (no `message` in data — exercises the fallback). */
export function outputLengthError() {
  return { name: 'MessageOutputLengthError' as const, data: {} };
}

/** Build a Todo entry. */
export function todo(id: string, content: string, status: string, priority = 'medium'): Todo {
  return { id, content, status, priority };
}

/** Build a `todo.updated` event. */
export function todoUpdated(sessionID: string, todos: Todo[]): Event {
  return { type: 'todo.updated', properties: { sessionID, todos } };
}

/** Build a Session info payload (bookkeeping events, not turn events). */
export function sessionInfo(sessionID: string, directory = DIRECTORY): Session {
  return {
    id: sessionID,
    projectID: 'prj_0001',
    directory,
    title: 'fixture session',
    version: '1.17.13',
    time: { created: CREATED_AT, updated: CREATED_AT },
  };
}

/** Build a `session.updated` bookkeeping event (ignore-list member). */
export function sessionUpdated(info: Session): Event {
  return { type: 'session.updated', properties: { info } };
}

/** Build a `file.edited` event (ignore-list member). */
export function fileEdited(file: string): Event {
  return { type: 'file.edited', properties: { file } };
}

/** Build a `server.connected` stream-open event (ignore-list member). */
export function serverConnected(): Event {
  return { type: 'server.connected', properties: {} };
}

/**
 * A `server.heartbeat` WIRE event: emitted every 10s by both `/event` and
 * `/global/event` at v1.17.13 but absent from the SDK's Event union — proves
 * the mapper tolerates unknown runtime event types via its default case.
 */
export function wireHeartbeat(): OpenCodeWireEvent {
  return { type: 'server.heartbeat', properties: {} } as unknown as OpenCodeWireEvent;
}

/** Wrap a payload in the `/global/event` envelope. */
export function globalEvent(directory: string, payload: OpenCodeWireEvent): GlobalEvent {
  return { directory, payload: payload as GlobalEvent['payload'] };
}

// === Scripted turns ===

/**
 * A complete streamed text turn, exactly as the v1.17.13 server publishes it:
 * busy status → empty text-start snapshot → true increments as
 * `message.part.delta` → full-text end snapshot → completed assistant message
 * (usage) → idle status → `session.idle` terminal.
 */
export function opencodeSimpleTurn(sessionID: string, text: string): OpenCodeWireEvent[] {
  const partID = 'prt_text01';
  const mid = Math.ceil(text.length / 2);
  return [
    statusEvent(sessionID, { type: 'busy' }),
    partUpdated(textPart(sessionID, partID, '')),
    partDelta(sessionID, partID, text.slice(0, mid)),
    partDelta(sessionID, partID, text.slice(mid)),
    partUpdated(textPart(sessionID, partID, text, { end: true })),
    messageUpdated(assistantMessage(sessionID, { completed: true })),
    statusEvent(sessionID, { type: 'idle' }),
    sessionIdle(sessionID),
  ];
}

/** A turn where a bash tool runs to completion before a closing text snapshot. */
export function opencodeToolTurn(sessionID: string): OpenCodeWireEvent[] {
  const input = { command: 'ls -la' };
  return [
    statusEvent(sessionID, { type: 'busy' }),
    partUpdated(toolPart(sessionID, 'call_001', 'bash', toolStatePending(input))),
    partUpdated(toolPart(sessionID, 'call_001', 'bash', toolStateRunning(input))),
    partUpdated(
      toolPart(sessionID, 'call_001', 'bash', toolStateCompleted(input, 'file1\nfile2\n'))
    ),
    partUpdated(textPart(sessionID, 'prt_text01', 'Two files.', { end: true })),
    messageUpdated(assistantMessage(sessionID, { completed: true })),
    statusEvent(sessionID, { type: 'idle' }),
    sessionIdle(sessionID),
  ];
}

/**
 * A turn that raises a tool approval: `permission.updated` mid-turn, resolved
 * (`permission.replied`) before the tool executes and the turn completes.
 */
export function opencodeApprovalTurn(sessionID: string): OpenCodeWireEvent[] {
  const input = { command: 'rm -rf dist' };
  return [
    statusEvent(sessionID, { type: 'busy' }),
    partUpdated(toolPart(sessionID, 'call_001', 'bash', toolStatePending(input))),
    permissionUpdated(permission(sessionID, { id: 'per_0001', callID: 'call_001' })),
    permissionReplied(sessionID, 'per_0001', 'once'),
    partUpdated(toolPart(sessionID, 'call_001', 'bash', toolStateRunning(input))),
    partUpdated(toolPart(sessionID, 'call_001', 'bash', toolStateCompleted(input, ''))),
    partUpdated(textPart(sessionID, 'prt_text01', 'Removed dist.', { end: true })),
    messageUpdated(assistantMessage(sessionID, { completed: true })),
    statusEvent(sessionID, { type: 'idle' }),
    sessionIdle(sessionID),
  ];
}

/**
 * A failed turn: upstream `halt()` publishes `session.error` and then sets the
 * session idle (status idle + `session.idle`).
 */
export function opencodeErrorTurn(sessionID: string, message: string): OpenCodeWireEvent[] {
  return [
    statusEvent(sessionID, { type: 'busy' }),
    sessionError(sessionID, unknownError(message)),
    statusEvent(sessionID, { type: 'idle' }),
    sessionIdle(sessionID),
  ];
}

/**
 * The interrupt/abort shape: partial text, then `session.error` carrying
 * `MessageAbortedError`, then idle — a user-initiated stop, not a failure.
 */
export function opencodeAbortedTurn(sessionID: string, partialText: string): OpenCodeWireEvent[] {
  const partID = 'prt_text01';
  return [
    statusEvent(sessionID, { type: 'busy' }),
    partUpdated(textPart(sessionID, partID, '')),
    partDelta(sessionID, partID, partialText),
    sessionError(sessionID, abortedError()),
    statusEvent(sessionID, { type: 'idle' }),
    sessionIdle(sessionID),
  ];
}

/**
 * Two sessions interleaved on ONE global stream — both in {@link DIRECTORY} so
 * only the `sessionID` half of the demux key separates them — plus one
 * pathological event reusing session A's id under a different directory (must
 * be excluded by the directory half of the key).
 */
export function interleavedGlobalStream(): GlobalEvent[] {
  const a = OC_SESSION_A;
  const b = OC_SESSION_B;
  return [
    globalEvent(DIRECTORY, statusEvent(a, { type: 'busy' })),
    globalEvent(DIRECTORY, statusEvent(b, { type: 'busy' })),
    globalEvent(DIRECTORY, partUpdated(textPart(a, 'prt_a1', ''))),
    globalEvent(DIRECTORY, partUpdated(textPart(b, 'prt_b1', ''))),
    globalEvent(DIRECTORY, partDelta(a, 'prt_a1', 'Alpha ')),
    globalEvent(DIRECTORY, partDelta(b, 'prt_b1', 'Beta ')),
    // Same session id as A but a different directory — never A's turn.
    globalEvent(OTHER_DIRECTORY, partDelta(a, 'prt_x1', 'INTRUDER')),
    globalEvent(DIRECTORY, partDelta(a, 'prt_a1', 'says hi')),
    globalEvent(DIRECTORY, partDelta(b, 'prt_b1', 'says yo')),
    globalEvent(DIRECTORY, partUpdated(textPart(a, 'prt_a1', 'Alpha says hi', { end: true }))),
    globalEvent(DIRECTORY, partUpdated(textPart(b, 'prt_b1', 'Beta says yo', { end: true }))),
    globalEvent(DIRECTORY, sessionIdle(a)),
    globalEvent(DIRECTORY, sessionIdle(b)),
  ];
}

// === Stream fakes ===

/** Yield scripted events as an async stream — the per-session mapper input. */
export function toEventStream(events: OpenCodeWireEvent[]): AsyncGenerator<OpenCodeWireEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

/**
 * The fake `/global/event` SSE server: an async generator yielding recorded
 * GlobalEvent envelopes exactly like `client.global.event()`'s `.stream`.
 */
export function fakeGlobalEventStream(events: GlobalEvent[]): AsyncGenerator<GlobalEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}
