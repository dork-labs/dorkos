import { randomUUID } from 'node:crypto';
import {
  matchesCanvasChannelEvent,
  type StoredPageEvent,
} from '@dorkos/shared/canvas-channel-schemas';
import { type DocIngestAccess, DocIngestRefusal } from './ingest-types.js';
import { DOC_EVENTS_PROMPT_BYTES, docEventsPromptBytes } from '../prompt.js';
import type { envelopeIdentity } from '../envelope.js';

/** Validate the fixed envelope and renderer budget without issuing source authority. */
export function validateIngestEnvelope(
  event: StoredPageEvent,
  identity: ReturnType<typeof envelopeIdentity>,
  access: DocIngestAccess,
  nextDocSeq: number
): DocIngestAccess['routes'] {
  if (identity.bytes > Math.min(access.envelopeBytes ?? 16384, 16384))
    throw new DocIngestRefusal('DOC_EVENT_TOO_LARGE', 413);
  try {
    const validation: unknown = access.validatePayload?.(event.type, event.payload);
    if (
      validation &&
      (typeof validation === 'object' || typeof validation === 'function') &&
      'then' in validation
    ) {
      void Promise.resolve(validation).catch(() => {});
      throw new Error('Document payload validation must be synchronous.');
    }
  } catch {
    throw new DocIngestRefusal('INVALID_DOC_EVENT_PAYLOAD', 422);
  }
  const matching = access.routes.filter(({ route }) =>
    matchesCanvasChannelEvent(route.on, event.type)
  );
  // Even one input must fit the actual future renderer, including server labels and escaping.
  for (const { route, grantId } of matching) {
    if (!grantId || route.to === 'log' || route.turn.mode === 'none') continue;
    if (
      docEventsPromptBytes({
        documentId: access.documentId,
        documentLabel: access.documentLabel,
        scope: access.scope,
        batchId: randomUUID(),
        routeId: route.id,
        grantId,
        events: [{ id: event.id, type: event.type, payload: event.payload, docSeq: nextDocSeq }],
      }) > DOC_EVENTS_PROMPT_BYTES
    )
      throw new DocIngestRefusal('DOC_EVENT_CONTEXT_TOO_LARGE', 413);
  }
  return matching;
}
