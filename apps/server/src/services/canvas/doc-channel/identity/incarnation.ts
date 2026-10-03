/** Pure server-derived physical/channel incarnation; no authority issuer or mutable revision. */
import { createHash } from 'node:crypto';
import {
  CanvasChannelCheckboxRequestSchema,
  CanvasChannelCheckboxIntentSchema,
} from '@dorkos/shared/canvas-channel-schemas';

/** Physical and retained channel rows must describe the same incarnation. */
export class DocDocumentIncarnationError extends Error {
  readonly code = 'DOCUMENT_INCARNATION_CHANGED';
  constructor() {
    super('Document incarnation changed.');
  }
}

/** Shared immutable physical/channel birth tuple; excludes mutable revision, scope and page nonce. */
export function docDocumentGeneration(
  physical: { id: string; openedAt: string },
  channel: { documentId: string; createdAt: string }
): string {
  CanvasChannelCheckboxRequestSchema.shape.documentId.parse(physical.id);
  CanvasChannelCheckboxIntentSchema.shape.createdAt.parse(physical.openedAt);
  CanvasChannelCheckboxIntentSchema.shape.createdAt.parse(channel.createdAt);
  if (
    !physical.id ||
    physical.id !== channel.documentId ||
    !Number.isFinite(Date.parse(physical.openedAt)) ||
    !Number.isFinite(Date.parse(channel.createdAt))
  )
    throw new DocDocumentIncarnationError();
  return createHash('sha256')
    .update(
      JSON.stringify([
        'doc-checkbox-incarnation-v1',
        physical.id,
        physical.openedAt,
        channel.documentId,
        channel.createdAt,
      ])
    )
    .digest('hex');
}
