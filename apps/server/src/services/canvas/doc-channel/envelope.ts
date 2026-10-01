/** Canonical document-envelope hashing, independent of transport and server provenance. */
import { createHash } from 'node:crypto';
import type {
  CanvasChannelJsonValue,
  StoredPageEvent,
} from '@dorkos/shared/canvas-channel-schemas';

function ordered(value: CanvasChannelJsonValue): CanvasChannelJsonValue {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key]!)])
    );
  return value;
}

/** Serialize validated envelope fields only; object key order never changes its identity. */
export function canonicalEnvelope(event: StoredPageEvent): string {
  return JSON.stringify(
    ordered({
      v: event.v,
      id: event.id,
      type: event.type,
      payload: event.payload,
      ...(event.coalesceKey === undefined ? {} : { coalesceKey: event.coalesceKey }),
      ...(event.ts === undefined ? {} : { ts: event.ts }),
    })
  );
}

/** Original request fingerprint and precise UTF-8 accounting, excluding host metadata. */
export function envelopeIdentity(event: StoredPageEvent): { hash: string; bytes: number } {
  const serialized = canonicalEnvelope(event);
  return {
    hash: createHash('sha256').update(serialized).digest('hex'),
    bytes: Buffer.byteLength(serialized),
  };
}
