/**
 * Per-entry tolerance for session stream frames (DOR-2078).
 *
 * A snapshot frame carries a session's whole history. Validating it as one unit
 * meant a single malformed field anywhere — one tool call, one question — threw
 * the entire frame away, and the session never loaded at all. These parsers make
 * one bad entry cost that entry:
 *
 * - **Snapshot messages** are salvaged part by part, then message by message. An
 *   unreadable part or message is replaced by a placeholder in the same position,
 *   so the reader can see something is missing rather than a silent gap.
 * - **Pending interactions** keep their valid items. An unreadable one that the
 *   in-progress turn does not already show gets a trailing note: the session is
 *   still waiting on the person, and without a card or a note it would read as
 *   "waiting on you" with nothing to answer.
 * - **Queued messages and canvas** keep their valid items and drop the rest: they
 *   have no transcript position, and the server re-derives both on the next frame.
 * - **The snapshot envelope** (`status`, `cursor`) is not salvageable. Without a
 *   trustworthy cursor there is no gap-free resume point, so the frame is still
 *   rejected exactly as before.
 * - **Live events** stay all-or-nothing, with one exception: a prompt that blocks
 *   the turn on the operator (question, approval, elicitation). Dropping one of
 *   those left the turn waiting on a card nobody could see, so it becomes an
 *   inline `error` event at the same `seq` instead. Every other live event is
 *   transient — the settled turn arrives through history, where the per-message
 *   tolerance above applies — so dropping it with a warning stays correct.
 *
 * Every placeholder and stand-in carries {@link UNREADABLE_ENTRY_ERROR_CODE}, which
 * is what renders it as a quiet note, keeps it out of `status.lastError`, and stops
 * it from hiding the turn-failed notice.
 *
 * @module shared/lib/transport/tolerant-session-frames
 */
import type { ZodError, ZodType } from 'zod';
import { UNREADABLE_ENTRY_ERROR_CODE } from '@dorkos/shared/run-outcome';
import {
  HistoryMessageSchema,
  MessagePartSchema,
  type HistoryMessage,
  type MessagePart,
} from '@dorkos/shared/schemas';
import {
  InteractionPendingEventSchema,
  PendingInteractionsResponseSchema,
  type PendingInteractionsResponse,
} from '@dorkos/shared/interaction-events';
import {
  SessionEventSchema,
  SessionSnapshotSchema,
  type SessionEvent,
  type SessionSnapshot,
} from '@dorkos/shared/session-stream';

/** What an unreadable part or message shows in its place in the transcript. */
export const UNREADABLE_MESSAGE_TEXT = 'This part of the conversation couldn’t be shown.';

/** What an unreadable question, approval or elicitation shows while the agent waits. */
export const UNREADABLE_PROMPT_TEXT =
  'The agent asked you something here, but it couldn’t be shown. You can stop the agent and ask it again.';

/** The live event types that pause the turn until the operator answers. */
const BLOCKING_PROMPT_TYPES: ReadonlySet<string> = new Set([
  'question_prompt',
  'approval_required',
  'elicitation_prompt',
]);

/** One entry that failed validation: where it sat in the frame, and the first reason. */
export interface UnreadableEntry {
  /** Dotted path from the frame root to the failing field, e.g. `messages.3.parts.1.status`. */
  path: string;
  /** The schema's message for the first issue found there. */
  message: string;
}

/** The outcome of {@link parseSessionSnapshot}. */
export type SnapshotParseResult =
  | { ok: true; snapshot: SessionSnapshot; unreadable: UnreadableEntry[] }
  | { ok: false; error: ZodError };

/** The outcome of {@link parseSessionEvent}. */
export type SessionEventParseResult =
  | { ok: true; event: SessionEvent; unreadable: UnreadableEntry | null }
  | { ok: false; error: ZodError };

const PLACEHOLDER_PART: MessagePart = {
  type: 'error',
  message: UNREADABLE_MESSAGE_TEXT,
  code: UNREADABLE_ENTRY_ERROR_CODE,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeIssue(error: ZodError, prefix: PropertyKey[]): UnreadableEntry {
  const issue = error.issues[0];
  return {
    path: [...prefix, ...(issue?.path ?? [])].map(String).join('.'),
    message: issue?.message ?? 'Invalid value',
  };
}

/** Replace each unreadable part with the placeholder, collapsing adjacent placeholders. */
function salvageParts(rawParts: unknown[]): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const raw of rawParts) {
    const parsed = MessagePartSchema.safeParse(raw);
    if (parsed.success) parts.push(parsed.data);
    else if (parts.at(-1) !== PLACEHOLDER_PART) parts.push(PLACEHOLDER_PART);
  }
  return parts;
}

/**
 * A transcript row holding only a note. Always an assistant row: a user row
 * renders its `content` as if the person had typed it, which a note must never
 * read as.
 */
function noteMessage(id: string, part: MessagePart, timestamp?: unknown): HistoryMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    parts: [part],
    ...(typeof timestamp === 'string' ? { timestamp } : {}),
  };
}

function salvageMessage(
  raw: unknown,
  index: number,
  unreadable: UnreadableEntry[]
): HistoryMessage {
  const whole = HistoryMessageSchema.safeParse(raw);
  if (whole.success) return whole.data;
  unreadable.push(describeIssue(whole.error, ['messages', index]));

  const record = isRecord(raw) ? raw : {};
  // Most real defects live inside one part (DOR-2075 was one question on one
  // tool call), so try keeping the message and replacing only what failed.
  if (Array.isArray(record.parts)) {
    const retry = HistoryMessageSchema.safeParse({ ...record, parts: salvageParts(record.parts) });
    if (retry.success) return retry.data;
  }
  const id = typeof record.id === 'string' ? record.id : `unreadable-message-${index}`;
  return noteMessage(id, PLACEHOLDER_PART, record.timestamp);
}

/** Keep the valid items of a list field; a non-array is returned untouched so the envelope check still fails it. */
function keepValidItems<T>(
  schema: ZodType<T>,
  raw: unknown,
  field: string,
  unreadable: UnreadableEntry[]
): unknown {
  if (!Array.isArray(raw)) return raw;
  const kept: T[] = [];
  raw.forEach((item, index) => {
    const parsed = schema.safeParse(item);
    if (parsed.success) kept.push(parsed.data);
    else unreadable.push(describeIssue(parsed.error, [field, index]));
  });
  return kept;
}

function salvageTurnEvents(raw: unknown, unreadable: UnreadableEntry[]): unknown {
  if (!Array.isArray(raw)) return raw;
  const kept: SessionEvent[] = [];
  raw.forEach((item, index) => {
    const result = parseSessionEvent(item);
    if (!result.ok) {
      unreadable.push(describeIssue(result.error, ['inProgressTurn', index]));
      return;
    }
    if (result.unreadable) {
      unreadable.push({
        ...result.unreadable,
        path: `inProgressTurn.${index}.${result.unreadable.path}`,
      });
    }
    kept.push(result.event);
  });
  return kept;
}

/** Whether the raw in-progress turn already carries an entry for this interaction id. */
function turnMentions(rawTurn: unknown, id: unknown): boolean {
  if (typeof id !== 'string' || !Array.isArray(rawTurn)) return false;
  return rawTurn.some((event) => isRecord(event) && (event.id === id || event.toolCallId === id));
}

/**
 * Notes for unreadable pending interactions the turn does not show. A session
 * still blocked after `turn_end` has no turn at all, so this is the only place
 * such a prompt could surface (see `foldPendingInteractions`).
 */
function orphanedPromptNotes(raw: Record<string, unknown>): HistoryMessage[] {
  if (!Array.isArray(raw.pendingInteractions)) return [];
  const shape = SessionSnapshotSchema.shape;
  const notes: HistoryMessage[] = [];
  raw.pendingInteractions.forEach((item, index) => {
    if (shape.pendingInteractions.element.safeParse(item).success) return;
    const id = isRecord(item) ? item.id : undefined;
    if (turnMentions(raw.inProgressTurn, id)) return;
    const noteId = `unreadable-interaction-${typeof id === 'string' ? id : index}`;
    notes.push(
      noteMessage(noteId, {
        type: 'error',
        message: UNREADABLE_PROMPT_TEXT,
        code: UNREADABLE_ENTRY_ERROR_CODE,
      })
    );
  });
  return notes;
}

/**
 * Validate a snapshot frame, salvaging what can be salvaged when the whole-frame
 * parse fails. A fully valid frame takes the fast path and comes back exactly as
 * the schema parsed it.
 *
 * @param data - The raw frame payload off the stream.
 * @returns The snapshot plus every entry that was replaced or dropped, or the
 *   schema error when the envelope itself (`status`, `cursor`) is unreadable.
 */
export function parseSessionSnapshot(data: unknown): SnapshotParseResult {
  const whole = SessionSnapshotSchema.safeParse(data);
  if (whole.success) return { ok: true, snapshot: whole.data, unreadable: [] };
  if (!isRecord(data)) return { ok: false, error: whole.error };

  const unreadable: UnreadableEntry[] = [];
  const shape = SessionSnapshotSchema.shape;
  const candidate = {
    ...data,
    messages: Array.isArray(data.messages)
      ? [
          ...data.messages.map((message, index) => salvageMessage(message, index, unreadable)),
          ...orphanedPromptNotes(data),
        ]
      : data.messages,
    inProgressTurn: salvageTurnEvents(data.inProgressTurn, unreadable),
    pendingInteractions: keepValidItems(
      shape.pendingInteractions.element,
      data.pendingInteractions,
      'pendingInteractions',
      unreadable
    ),
    queuedMessages: keepValidItems(
      shape.queuedMessages.element,
      data.queuedMessages,
      'queuedMessages',
      unreadable
    ),
    canvas: keepValidItems(shape.canvas.element, data.canvas, 'canvas', unreadable),
  };
  const retry = SessionSnapshotSchema.safeParse(candidate);
  return retry.success
    ? { ok: true, snapshot: retry.data, unreadable }
    : { ok: false, error: retry.error };
}

/**
 * Validate one live session event. An unreadable blocking prompt becomes an
 * inline `error` event at the same `seq`, so the operator sees that the agent is
 * waiting on something; any other unreadable event is reported as an error.
 *
 * @param data - The raw frame payload off the stream.
 */
export function parseSessionEvent(data: unknown): SessionEventParseResult {
  const parsed = SessionEventSchema.safeParse(data);
  if (parsed.success) return { ok: true, event: parsed.data, unreadable: null };
  if (isRecord(data) && typeof data.type === 'string' && BLOCKING_PROMPT_TYPES.has(data.type)) {
    const standIn = SessionEventSchema.safeParse({
      type: 'error',
      seq: data.seq,
      message: UNREADABLE_PROMPT_TEXT,
      code: UNREADABLE_ENTRY_ERROR_CODE,
    });
    if (standIn.success) {
      return {
        ok: true,
        event: standIn.data,
        unreadable: describeIssue(parsed.error, [data.type]),
      };
    }
  }
  return { ok: false, error: parsed.error };
}

/**
 * Validate the fleet-wide pending-interactions list, keeping every readable
 * entry. One unreadable prompt must not blank the list for the rest.
 *
 * @param data - The raw `GET /sessions/pending-interactions` body.
 * @throws ZodError when the body is not a list response at all.
 */
export function parsePendingInteractionsResponse(data: unknown): PendingInteractionsResponse {
  const whole = PendingInteractionsResponseSchema.safeParse(data);
  if (whole.success) return whole.data;
  if (!isRecord(data) || !Array.isArray(data.interactions)) throw whole.error;
  const unreadable: UnreadableEntry[] = [];
  const interactions = keepValidItems(
    InteractionPendingEventSchema,
    data.interactions,
    'interactions',
    unreadable
  );
  const retry = PendingInteractionsResponseSchema.safeParse({ ...data, interactions });
  if (!retry.success) throw retry.error;
  console.warn('[Transport] skipped unreadable pending interactions', { unreadable });
  return retry.data;
}

/** A warner that reports each key once for the life of the page. */
function createOnceWarner(
  scope: string,
  text: string
): (key: string, payload: Record<string, unknown>) => void {
  const reported = new Set<string>();
  return (key, payload) => {
    if (reported.has(key)) return;
    reported.add(key);
    console.warn(`[${scope}] ${text}`, payload);
  };
}

/**
 * Build a warner that reports a session's unreadable snapshot entries once.
 *
 * Every reconnect delivers a fresh snapshot of the same history, so warning per
 * frame would repeat the same defect on every network blip. The first report
 * carries every failing path, which is what finding the defect needs.
 *
 * @param scope - The log prefix, e.g. `StreamManager`.
 */
export function createUnreadableSnapshotReporter(
  scope: string
): (sessionId: string, unreadable: UnreadableEntry[]) => void {
  const warn = createOnceWarner(scope, 'showing placeholders for unreadable snapshot entries');
  return (sessionId, unreadable) => {
    if (unreadable.length === 0) return;
    warn(sessionId, { sessionId, unreadable });
  };
}

/**
 * Build a warner that reports each unreadable live prompt once, keyed by session
 * and `seq`, so a replay from `Last-Event-ID` does not repeat it.
 *
 * @param scope - The log prefix, e.g. `StreamManager`.
 */
export function createUnreadablePromptReporter(
  scope: string
): (sessionId: string, seq: number, unreadable: UnreadableEntry) => void {
  const warn = createOnceWarner(scope, 'showing a placeholder for an unreadable prompt');
  return (sessionId, seq, unreadable) => {
    warn(`${sessionId}:${seq}`, { sessionId, seq, unreadable });
  };
}
