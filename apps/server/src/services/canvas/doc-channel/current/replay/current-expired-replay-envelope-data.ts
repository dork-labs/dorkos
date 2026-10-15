import type { CanvasChannelBatchReplayRequest } from '@dorkos/shared/canvas-channel-schemas';
import type { DocBatchRow } from '../../store.js';
import { envelopeIdentity } from '../../envelope.js';

/** Spell only explicit-replay envelope DATA; no source selection, mutation or admission authority. */
export function createOriginalExpiredReplayEnvelope(
  request: CanvasChannelBatchReplayRequest,
  old: Pick<DocBatchRow, 'batchId' | 'generation' | 'routeId'>,
  nextId: string,
  generation: string
) {
  const payload = {
    operation: 'explicit_replay',
    previousBatchId: old.batchId,
    previousGeneration: old.generation,
    documentGeneration: request.expectedGeneration,
    grantId: request.grantId,
    batchId: nextId,
    generation,
    routeId: old.routeId,
    status: 'pending',
  };
  const identity = envelopeIdentity({
    v: 1,
    id: request.eventId,
    type: 'event.status',
    payload,
  });
  return { payload, identity };
}
