/** Bounded pending-input selection; the coalescer retains transaction and original-identity ownership. */
import type { DbTransaction } from '@dorkos/db';
import {
  DocChannelStore,
  DocChannelCorruptionError,
  type DocBatchRow,
  type DocEventRow,
} from './store.js';
import { DocIngestRefusal } from './ingest-data/ingest-types.js';
import {
  buildBatchDocContext as batchContext,
  requireCurrentBatchSliceBounds,
} from './current/current-operation-intentions.js';
import type { DocBatchSlice } from './current/current-operation-types.js';
import { docEventsPromptBytes, DOC_EVENTS_PROMPT_BYTES } from './prompt.js';

/** Select at most 100 originals and the exact rendered byte budget; no input is silently dropped. */
export function selectBatchSlice(
  store: DocChannelStore,
  tx: DbTransaction,
  batch: DocBatchRow,
  maxBatch: number,
  documentLabel: string,
  promptBytes = DOC_EVENTS_PROMPT_BYTES
): DocBatchSlice {
  requireCurrentBatchSliceBounds(promptBytes, maxBatch);
  if (!['pending', 'waiting'].includes(batch.status))
    throw new Error('Only pending inputs can be selected.');
  if (new Set(batch.inputEventIds).size !== batch.inputEventIds.length)
    throw new DocChannelCorruptionError('canvas_doc_batches', batch.batchId);
  const selected: DocEventRow[] = [];
  const inputs = batch.inputEventIds
    .map((id) => {
      const event = store.getEvent(batch.documentId, id, tx);
      if (!event || event.payloadPrunedAt !== null)
        throw new DocChannelCorruptionError('canvas_doc_batches', batch.batchId);
      return event;
    })
    .sort((a, b) => a.docSeq - b.docSeq);
  for (const event of inputs) {
    if (
      selected.length === maxBatch ||
      docEventsPromptBytes(batchContext(batch, [...selected, event], documentLabel)) > promptBytes
    )
      break;
    selected.push(event);
  }
  if (!selected.length) throw new DocIngestRefusal('DOC_EVENT_CONTEXT_TOO_LARGE', 413);
  return {
    batch: {
      ...batch,
      inputEventIds: selected.map((event) => event.eventId),
      effectivePayload: { eventIds: selected.map((event) => event.eventId), documentLabel },
    },
    context: batchContext(batch, selected, documentLabel),
    overflowIds: inputs.slice(selected.length).map((event) => event.eventId),
  };
}
