/**
 * Browser-safe pending delivery state for agent output in remote community rooms.
 *
 * @module shared/community-deliveries
 */
import { z } from 'zod';
import { CommunityRefSchema } from './community-adapter.js';

/** Browser-safe metadata for one pending delivery attachment. */
export const CommunityDeliveryAttachmentSchema = z.strictObject({
  name: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(255),
  byteSize: z.number().int().nonnegative().safe(),
});
/** Attachment metadata that contains no local storage identifier or path. */
export type CommunityDeliveryAttachment = z.infer<typeof CommunityDeliveryAttachmentSchema>;

/** Public identity snapshot for a locally owned agent's remote delivery. */
export const CommunityDeliveryAuthorSchema = z.strictObject({
  kind: z.literal('agent'),
  displayName: z.string().trim().min(1).max(120),
});
/** Browser-safe delivery author. */
export type CommunityDeliveryAuthor = z.infer<typeof CommunityDeliveryAuthorSchema>;

const CommunityDeliveryBaseSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(128),
  author: CommunityDeliveryAuthorSchema,
  text: z.string().max(100_000),
  parentEntryId: z.string().min(1).max(128).nullable(),
  attachments: z.array(CommunityDeliveryAttachmentSchema).max(8),
});

/** A local agent output still awaiting a remote receipt or matching echo. */
export const CommunityPendingDeliverySchema = CommunityDeliveryBaseSchema.extend({
  state: z.literal('pending'),
  failure: z.null(),
});
/** A delivery that needs a person to retry or repair before it can be shared. */
export const CommunityFailedDeliverySchema = CommunityDeliveryBaseSchema.extend({
  state: z.literal('failed'),
  failure: z.enum(['expired', 'not-confirmed']),
});
/** One owner-safe pending or failed remote agent delivery. */
export const CommunityDeliverySchema = z.discriminatedUnion('state', [
  CommunityPendingDeliverySchema,
  CommunityFailedDeliverySchema,
]);
/** One delivery shown until an authoritative remote entry confirms it. */
export type CommunityDelivery = z.infer<typeof CommunityDeliverySchema>;

/** A complete bounded replacement view for one qualified remote room. */
export const CommunityDeliverySnapshotSchema = z
  .strictObject({
    community: CommunityRefSchema,
    roomId: z.string().min(1).max(128),
    deliveries: z.array(CommunityDeliverySchema).max(100),
  })
  .superRefine((snapshot, context) => {
    const known = new Set<string>();
    snapshot.deliveries.forEach((delivery, index) => {
      if (known.has(delivery.idempotencyKey)) {
        context.addIssue({
          code: 'custom',
          path: ['deliveries', index, 'idempotencyKey'],
          message: 'Each delivery must have a unique idempotency key',
        });
      }
      known.add(delivery.idempotencyKey);
    });
  });
/** Owner-safe delivery snapshot used for both initial state and live replacement events. */
export type CommunityDeliverySnapshot = z.infer<typeof CommunityDeliverySnapshotSchema>;
