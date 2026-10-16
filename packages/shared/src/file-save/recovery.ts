/** Authenticated receipt-only recovery: no draft, pathname, authority or route input. */
import { z } from 'zod';
import {
  CanvasDocIncarnationSchema,
  CanvasChannelEventIdSchema,
  sameCanvasDocIncarnation,
} from '../canvas-channel-schemas.js';
import { FileDocumentSaveReceiptSchema } from './schemas.js';
import { extendZodWithOpenApiOnce } from '../zod-openapi.js';
extendZodWithOpenApiOnce();
// Fresh generation schema after extension: neutral birth objects may predate the extension.
// Private metadata clones preserve the exact runtime validation, including Unicode regex flags.
const hashPattern = /^[a-f0-9]{64}$/u;
const RecoveryIncarnationSchema = CanvasDocIncarnationSchema.extend({
  generation: z.string().regex(hashPattern).openapi({ pattern: hashPattern.source }),
});
const RecoveryEventIdSchema = CanvasChannelEventIdSchema.openapi({
  pattern: '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$',
});
const id = z.string().min(1).max(200);
export const FileSaveRecoverBodySchema = z
  .object({ expectedIncarnation: RecoveryIncarnationSchema })
  .strict();
export const FileSaveRecoveryLookupSchema = FileSaveRecoverBodySchema.extend({
  documentId: id,
  eventId: RecoveryEventIdSchema,
})
  .strict()
  .refine(
    (input) => input.documentId === input.expectedIncarnation.documentId,
    'Document birth differs.'
  );
const common = {
  eventId: RecoveryEventIdSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
};
export const FileSaveRecoveryEntrySchema = z.discriminatedUnion('state', [
  z
    .object({
      ...common,
      state: z.literal('receipt'),
      receipt: FileDocumentSaveReceiptSchema,
      historical: z.literal(true),
      currentFileMatch: z.enum(['same_saved_replacement', 'different', 'not_checked']),
    })
    .strict(),
  z.object({ ...common, state: z.literal('no_op'), historical: z.literal(true) }).strict(),
  z.object({ ...common, state: z.literal('failed'), historical: z.literal(true) }).strict(),
  z
    .object({
      ...common,
      state: z.literal('review'),
      reason: z.enum([
        'prepared_without_replacement',
        'replacement_not_proven',
        'proof_unavailable',
      ]),
    })
    .strict(),
]);
export const FileSaveDiscoverySchema = z
  .object({
    documentId: id,
    incarnation: RecoveryIncarnationSchema,
    entries: z.array(FileSaveRecoveryEntrySchema).max(25),
    hasMore: z.boolean(),
    window: z.literal('latest_25_current_owner_birth'),
    admission: z.enum(['blocked', 'not_observed_blocked']),
  })
  .strict()
  .refine(
    (result) =>
      result.documentId === result.incarnation.documentId &&
      result.entries.every(
        (entry) =>
          entry.state !== 'receipt' ||
          (entry.receipt.documentId === result.documentId &&
            entry.receipt.eventId === entry.eventId &&
            sameCanvasDocIncarnation(entry.receipt.incarnation, result.incarnation))
      ),
    'Receipt scope differs.'
  );
export const FileSaveRecoverResultSchema = z
  .object({
    documentId: id,
    incarnation: RecoveryIncarnationSchema,
    entry: FileSaveRecoveryEntrySchema,
  })
  .strict()
  .refine(
    (result) =>
      result.documentId === result.incarnation.documentId &&
      (result.entry.state !== 'receipt' ||
        (result.entry.receipt.documentId === result.documentId &&
          result.entry.receipt.eventId === result.entry.eventId &&
          sameCanvasDocIncarnation(result.entry.receipt.incarnation, result.incarnation))),
    'Receipt scope differs.'
  );
export type FileSaveRecoveryEntry = z.infer<typeof FileSaveRecoveryEntrySchema>;
export type FileSaveDiscovery = z.infer<typeof FileSaveDiscoverySchema>;
export type FileSaveRecoverResult = z.infer<typeof FileSaveRecoverResultSchema>;
