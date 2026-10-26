/**
 * Put back, as one lasting line under each stopped turn, the background
 * commands a Stop could not end, and how each one later ended (DOR-3285).
 *
 * A Stop ends the shells its turn started by task id. One the CLI will not
 * stop keeps running, so DorkOS records a `work_left_running` event naming it,
 * and a `work_left_ended` when the CLI later reports its end. Both happen after
 * the turn, so both are recorded the instant they arrive
 * (`EAGERLY_RECORDED_EVENT_TYPES`), and this overlay folds them into one
 * `work_left_running` part placed at the end of the stopped turn. The
 * runtime's own transcript records neither.
 *
 * Sibling of `model-substitution-overlay`, with the same never-throws contract
 * and the same subtraction of the OPEN turn's rows, which the live stream is
 * already drawing. Placed by TURN, not by clock: each record belongs to the
 * turn whose `turn_start` precedes it in `seq`.
 *
 * @module services/session/overlays/work-left-overlay
 */
import type { HistoryMessage, WorkLeftEndStatus, WorkLeftRunningPart } from '@dorkos/shared/types';
import { logger } from '../../../lib/logger.js';
import { getSessionEventStore, peekProjector } from '../session-state-projector.js';
import type { RecordedWorkLeft } from '../session-event-store.js';
import { turnOpenerIndex, type RecordedTurnStart } from './model-substitution-overlay.js';

/** A recorded `work_left_running` row. */
interface RunningRow {
  event: Extract<RecordedWorkLeft['event'], { type: 'work_left_running' }>;
  createdAt: string;
}

/** The `seq` of every `work_left_running` the open turn is still carrying live. */
function openTurnSeqs(sessionId: string): Set<number> {
  const seqs = new Set<number>();
  for (const event of peekProjector(sessionId)?.peekInProgressTurn() ?? []) {
    if (event.type === 'work_left_running') seqs.add(event.seq);
  }
  return seqs;
}

/** The standalone history row one recorded line becomes, with every later end folded in. */
function workLeftMessage(
  row: RunningRow,
  ends: ReadonlyMap<string, WorkLeftEndStatus>
): HistoryMessage {
  const part: WorkLeftRunningPart = {
    type: 'work_left_running',
    tasks: row.event.tasks.map((task) => {
      const ended = ends.get(task.taskId);
      return { taskId: task.taskId, command: task.command, ...(ended ? { ended } : {}) };
    }),
  };
  return {
    // Deterministic from the seq, so a reload reconciles onto the same row.
    id: `work-left-running-${row.event.seq}`,
    role: 'assistant',
    content: '',
    parts: [part],
    timestamp: row.createdAt,
  };
}

/**
 * The index to insert a line BEFORE: the first person's message after the
 * stopped turn opened, or the end of history when that turn is the last one.
 * `null` when the turn cannot be found at all.
 */
function insertionIndex(
  messages: readonly HistoryMessage[],
  row: RunningRow,
  starts: readonly RecordedTurnStart[]
): number | null {
  let opener = turnOpenerIndex(messages, row.event.seq, starts);
  if (opener === null) {
    // No recorded start to match by text: the last person's message dated at
    // or before the record opened the turn it closed.
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.role !== 'user' || message.timestamp === undefined) continue;
      if (message.timestamp <= row.createdAt) {
        opener = i;
        break;
      }
    }
  }
  if (opener === null) return null;
  for (let i = opener + 1; i < messages.length; i++) {
    if (messages[i]!.role === 'user') return i;
  }
  return messages.length;
}

/**
 * Splice recorded lines into assembled history, each at the end of the turn it
 * stopped; one whose turn cannot be found closes the history out. Returns
 * `messages` by reference when there are none.
 *
 * @param messages - History as the runtime assembled it.
 * @param rows - Recorded `work_left_running` and `work_left_ended` rows, in seq order.
 * @param starts - The session's recorded turn starts, in seq order.
 * @param skipSeqs - `work_left_running` seqs the open turn is still drawing live.
 */
export function applyWorkLeft(
  messages: HistoryMessage[],
  rows: RecordedWorkLeft[],
  starts: RecordedTurnStart[] = [],
  skipSeqs: ReadonlySet<number> = new Set()
): HistoryMessage[] {
  const ends = new Map<string, WorkLeftEndStatus>();
  const running: RunningRow[] = [];
  for (const row of rows) {
    const { event, createdAt } = row;
    if (event.type === 'work_left_ended') ends.set(event.taskId, event.status);
    else if (!skipSeqs.has(event.seq)) running.push({ event, createdAt });
  }
  if (running.length === 0) return messages;
  const before = new Map<number, HistoryMessage[]>();
  const trailing: HistoryMessage[] = [];
  for (const row of running) {
    const index = insertionIndex(messages, row, starts);
    if (index === null || index === messages.length) {
      trailing.push(workLeftMessage(row, ends));
    } else {
      before.set(index, [...(before.get(index) ?? []), workLeftMessage(row, ends)]);
    }
  }
  const merged: HistoryMessage[] = [];
  messages.forEach((message, i) => {
    merged.push(...(before.get(i) ?? []), message);
  });
  return [...merged, ...trailing];
}

/**
 * Overlay a session's recorded left-running work onto its history.
 *
 * **Never throws**: a store that cannot be read costs the line and nothing
 * else, never the conversation.
 *
 * @param sessionId - The canonical id the rows were recorded under.
 * @param messages - History as the runtime assembled it.
 */
export function overlayWorkLeftRunning(
  sessionId: string,
  messages: HistoryMessage[]
): HistoryMessage[] {
  let rows: RecordedWorkLeft[];
  let starts: RecordedTurnStart[] = [];
  let live: Set<number>;
  try {
    const store = getSessionEventStore();
    rows = store?.readWorkLeft(sessionId) ?? [];
    if (rows.length > 0) starts = store?.readTurnStarts(sessionId) ?? [];
    live = openTurnSeqs(sessionId);
  } catch (err) {
    logger.warn('[work-left] could not read recorded left-running work', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return messages;
  }
  return applyWorkLeft(messages, rows, starts, live);
}
