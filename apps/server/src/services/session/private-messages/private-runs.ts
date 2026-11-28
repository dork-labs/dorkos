/**
 * A protected source's message and its run (spec `turns-survive-restarts`
 * §4.7, "A private message's row"; DOR-5218).
 *
 * A private message's words are a placeholder queue row written with its
 * receipt, in the transaction that consumes its source, so the source is
 * used exactly once. Its run is written in that same transaction (transition
 * 1) and names where its words really are: `source_ref`, the document batch
 * for a page's events (`doc-batch:<batchId>`) and the receipt for every other
 * source (`private-receipt:<receiptId>`). The words themselves are read from
 * the source only at the final claim, and never replayed: an attempt whose
 * outcome nobody can know is quarantined, and so is its run.
 *
 * @module services/session/private-messages/private-runs
 */
import type { DbTransaction } from '@dorkos/db';
import type { TurnOrigin } from '@dorkos/shared/turn-port';
import { logger } from '../../../lib/logger.js';
import type { MessageQueueStore } from '../message-queue-store.js';
import { turnFacts } from '../turn-port/facts.js';
import type { PrivateSessionMessageSourceRef } from './source-types.js';

/**
 * The origin of each protected source's turn:
 *
 * - `connector_event`: a connector event woke an agent up.
 * - `connector_agent_request`: a person decided an agent's connection request,
 *   and DorkOS carries the asking chat on with the answer.
 * - `room_handoff_terminal`: a room hand-off ended, and DorkOS carries the
 *   chat that handed it off on with the result.
 * - `document_event_batch`: a page's events on a canvas document, which are
 *   app data like a mini app's message (DOR-4603), never a person's words.
 *
 * Exhaustive: a new source kind does not compile until it is decided here.
 *
 * @param kind - The source's kind.
 */
export function privateSourceOrigin(kind: PrivateSessionMessageSourceRef['kind']): TurnOrigin {
  switch (kind) {
    case 'connector_event':
      return { kind: 'connector-event' };
    case 'connector_agent_request':
    case 'room_handoff_terminal':
      return { kind: 'resume' };
    case 'document_event_batch':
      return { kind: 'extension-message' };
    default: {
      const unhandled: never = kind;
      throw new Error(`unhandled private source: ${String(unhandled)}`);
    }
  }
}

/**
 * Where a protected source's words wait, as its run's `source_ref`
 * (`<kind>:<id>`, spec §4.1): a page's events by their document batch (§6.5),
 * any other source by its receipt.
 *
 * @param source - The source's kind and own id, and the receipt accepting it.
 */
export function privateSourceRefOf(source: {
  sourceKind: PrivateSessionMessageSourceRef['kind'];
  sourceId: string;
  receiptId: string;
}): string {
  return source.sourceKind === 'document_event_batch'
    ? `doc-batch:${source.sourceId}`
    : `private-receipt:${source.receiptId}`;
}

/**
 * The queue row fields a protected source's message is enqueued with: who
 * queued it, and the origin and `source_ref` its run is written with.
 *
 * @param source - The source's kind and own id, and the receipt accepting it.
 */
export function privateQueueRowOf(source: Parameters<typeof privateSourceRefOf>[0]): {
  clientId: string;
  origin: TurnOrigin;
  sourceRef: string;
} {
  return {
    clientId: `system:${source.sourceKind}`,
    origin: privateSourceOrigin(source.sourceKind),
    sourceRef: privateSourceRefOf(source),
  };
}

/**
 * Take a private message's queue row away because its attempt's outcome is
 * unknown, and end its run the same way, in `tx`. A run whose runtime had
 * already read the words (`running`) has no row left, since `delivered`
 * deleted it; its run still names the row, so it is reached all the same and
 * never reads as a turn a restart may carry on (§4.7).
 *
 * @param queue - The queue the row was written to.
 * @param queueMessageId - The row.
 * @param tx - The transaction quarantining the receipt.
 */
export function quarantinePrivateRow(
  queue: MessageQueueStore,
  queueMessageId: string,
  tx: DbTransaction
): void {
  if (queue.remove(queueMessageId, tx, 'outcome_unknown')) return;
  const feed = turnFacts()?.dispatcher;
  try {
    feed?.queueRowsLeaving([queueMessageId], 'outcome_unknown');
  } catch (err) {
    // As every queue change does: the receipt's quarantine stands without it.
    logger.error('[private messages] the run record refused a quarantine', {
      queueMessageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
