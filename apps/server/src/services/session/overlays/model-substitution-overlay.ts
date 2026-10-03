/**
 * Put back, as a lasting notice, every turn that ran on another model than
 * its session names (DOR-2636).
 *
 * A session on DorkOS credits that names a model credits do not cover runs on
 * the service's suggestion instead. Never silently: the launch emits a
 * `model_substituted` event, which is recorded durably the instant it is
 * ingested (`EAGERLY_RECORDED_EVENT_TYPES`), and this overlay splices it back
 * into the conversation a person reopens. The runtime's own transcript cannot
 * answer for it: it names the model that ran and never the one it replaced.
 *
 * Sibling of `permission-denial-overlay`, with the same never-throws contract
 * and the same subtraction of the OPEN turn's events, which the live stream is
 * already drawing. Placed by TURN, not by clock: the record is written at
 * launch, a beat BEFORE the CLI writes the person's message to its transcript,
 * so a clock comparison would draw the notice above the message that caused
 * it. Each record belongs to the turn whose `turn_start` precedes it in `seq`,
 * and lands right after that turn's message.
 *
 * @module services/session/overlays/model-substitution-overlay
 */
import type { HistoryMessage, MessagePart } from '@dorkos/shared/types';
import { logger } from '../../../lib/logger.js';
import { getSessionEventStore, peekProjector } from '../session-state-projector.js';
import type { RecordedModelSubstitution } from '../session-event-store.js';

/** The `seq` of every substitution the open turn is still carrying live. */
function openTurnSeqs(sessionId: string): Set<number> {
  const seqs = new Set<number>();
  for (const event of peekProjector(sessionId)?.peekInProgressTurn() ?? []) {
    if (event.type === 'model_substituted') seqs.add(event.seq);
  }
  return seqs;
}

/** The standalone history row one recorded substitution becomes. */
function substitutionMessage(row: RecordedModelSubstitution): HistoryMessage {
  const { event } = row;
  const part: MessagePart = {
    type: 'model_substituted',
    from: event.from,
    fromName: event.fromName,
    to: event.to,
    toName: event.toName,
    reason: event.reason,
  };
  return {
    // Deterministic from the seq, so a reload reconciles onto the same row.
    id: `model-substituted-${event.seq}`,
    role: 'assistant',
    content: '',
    parts: [part],
    timestamp: row.createdAt,
  };
}

/** A recorded turn start: its `seq`, and the person's message it carried. */
export interface RecordedTurnStart {
  seq: number;
  userMessage: string | undefined;
}

/**
 * The index of the history message a substitution's turn opened with, or
 * `null` when it cannot be found.
 *
 * The turn is the last `turn_start` before the record in `seq`. Its message is
 * found by its text, counting earlier turns that carried the same text so a
 * repeated "continue" lands on the right one. A turn the store has no start for
 * (it never ended, so it was never flushed) falls back to the first person's
 * message dated at or after the record: still in the turn it opened, since the
 * record is written before that message.
 */
function openingMessageIndex(
  messages: readonly HistoryMessage[],
  row: RecordedModelSubstitution,
  starts: readonly RecordedTurnStart[]
): number | null {
  const opener = starts.filter((start) => start.seq < row.event.seq).at(-1);
  const text = opener?.userMessage;
  if (opener && text) {
    let skip = starts.filter(
      (start) => start.seq < opener.seq && start.userMessage === text
    ).length;
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!;
      if (message.role !== 'user' || !message.content.includes(text)) continue;
      if (skip === 0) return i;
      skip -= 1;
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (
      message.role === 'user' &&
      message.timestamp !== undefined &&
      message.timestamp >= row.createdAt
    ) {
      return i;
    }
  }
  return null;
}

/**
 * Splice recorded substitutions into assembled history, each right after the
 * message of the turn it opened (see {@link openingMessageIndex}); one whose
 * turn cannot be found closes the history out. Returns `messages` by
 * reference when there are none.
 *
 * @param messages - History as the runtime assembled it.
 * @param rows - Recorded substitutions, in seq order.
 * @param starts - The session's recorded turn starts, in seq order.
 */
export function applyModelSubstitutions(
  messages: HistoryMessage[],
  rows: RecordedModelSubstitution[],
  starts: RecordedTurnStart[] = []
): HistoryMessage[] {
  if (rows.length === 0) return messages;
  const after = new Map<number, HistoryMessage[]>();
  const trailing: HistoryMessage[] = [];
  for (const row of rows) {
    const index = openingMessageIndex(messages, row, starts);
    if (index === null) {
      trailing.push(substitutionMessage(row));
    } else {
      after.set(index, [...(after.get(index) ?? []), substitutionMessage(row)]);
    }
  }
  const merged: HistoryMessage[] = [];
  messages.forEach((message, i) => {
    merged.push(message, ...(after.get(i) ?? []));
  });
  return [...merged, ...trailing];
}

/**
 * Overlay a session's recorded model substitutions onto its history.
 *
 * **Never throws**: a store that cannot be read costs the notices and nothing
 * else, never the conversation.
 *
 * @param sessionId - The canonical id the substitutions were recorded under.
 * @param messages - History as the runtime assembled it.
 */
export function overlayModelSubstitutions(
  sessionId: string,
  messages: HistoryMessage[]
): HistoryMessage[] {
  let rows: RecordedModelSubstitution[];
  let starts: RecordedTurnStart[] = [];
  try {
    const store = getSessionEventStore();
    const recorded = store?.readModelSubstitutions(sessionId) ?? [];
    if (recorded.length > 0) starts = store?.readTurnStarts(sessionId) ?? [];
    const live = openTurnSeqs(sessionId);
    rows = live.size === 0 ? recorded : recorded.filter((row) => !live.has(row.event.seq));
  } catch (err) {
    logger.warn('[model-substitutions] could not read recorded substitutions', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return messages;
  }
  return applyModelSubstitutions(messages, rows, starts);
}
