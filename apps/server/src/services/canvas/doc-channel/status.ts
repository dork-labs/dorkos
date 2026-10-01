/** Trusted service status events share the same durable sequence and replay log as app inputs. */
import { randomUUID } from 'node:crypto';
import type { DbTransaction } from '@dorkos/db';
import {
  StoredPageEventSchema,
  type CanvasChannelJsonValue,
} from '@dorkos/shared/canvas-channel-schemas';
import { envelopeIdentity } from './envelope.js';
import { DocChannelStore } from './store.js';

/** Append in the caller's transition transaction; callers publish only once that transaction commits. */
export function appendDocStatus(
  store: DocChannelStore,
  tx: DbTransaction,
  documentId: string,
  payload: CanvasChannelJsonValue,
  now: string
) {
  const event = StoredPageEventSchema.parse({
    v: 1,
    id: randomUUID(),
    type: 'event.status',
    payload,
  });
  const identity = envelopeIdentity(event);
  return store.appendEvent(
    {
      documentId,
      eventId: event.id,
      direction: 'system',
      type: event.type,
      payload: event.payload,
      envelopeHash: identity.hash,
      envelopeBytes: identity.bytes,
      provenance: { source: 'doc-channel-service' },
      receivedAt: now,
    },
    tx
  );
}
