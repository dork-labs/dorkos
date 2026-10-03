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
 * Sibling of `permission-denial-overlay`, with the same placement rule
 * (`spliceByCreatedAt`), the same never-throws contract, and the same
 * subtraction of the OPEN turn's events, which the live stream is already
 * drawing.
 *
 * @module services/session/overlays/model-substitution-overlay
 */
import type { HistoryMessage, MessagePart } from '@dorkos/shared/types';
import { logger } from '../../../lib/logger.js';
import { getSessionEventStore, peekProjector } from '../session-state-projector.js';
import type { RecordedModelSubstitution } from '../session-event-store.js';
import { spliceByCreatedAt } from './splice-by-created-at.js';

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

/**
 * Splice recorded substitutions into assembled history, in wall-clock order.
 * Returns `messages` by reference when there are none.
 *
 * @param messages - History as the runtime assembled it.
 * @param rows - Recorded substitutions, in seq order.
 */
export function applyModelSubstitutions(
  messages: HistoryMessage[],
  rows: RecordedModelSubstitution[]
): HistoryMessage[] {
  if (rows.length === 0) return messages;
  return spliceByCreatedAt(messages, rows, substitutionMessage);
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
  try {
    const recorded = getSessionEventStore()?.readModelSubstitutions(sessionId) ?? [];
    const live = openTurnSeqs(sessionId);
    rows = live.size === 0 ? recorded : recorded.filter((row) => !live.has(row.event.seq));
  } catch (err) {
    logger.warn('[model-substitutions] could not read recorded substitutions', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return messages;
  }
  return applyModelSubstitutions(messages, rows);
}
