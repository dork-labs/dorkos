import { z } from 'zod';
import {
  BrowserBindingSchema,
  BrowserAttachmentSchema,
  BrowserReferenceSchema,
  BrowserCounterSchema,
  BrowserPermissionSchema,
} from './browser-schemas.js';
import { BrowserTimestampSchema } from './browser-schema-json.js';
import { CanvasDocumentSchema } from './canvas-schemas.js';
/** References select a private presentation; none supplies permission. */
export const BrowserCanvasPresentSchema = z
  .object({ binding: BrowserBindingSchema, target: BrowserAttachmentSchema })
  .strict();
export const BrowserCanvasShareSchema = z
  .object({
    attachmentId: BrowserReferenceSchema,
    recipient: z.string().min(1).max(128),
    permissions: z
      .array(BrowserPermissionSchema)
      .min(1)
      .max(7)
      .refine((items) => new Set(items).size === items.length),
    expiresAt: BrowserTimestampSchema,
  })
  .strict();
export const BrowserCanvasDeliverySchema = z
  .object({
    attachmentId: BrowserReferenceSchema,
    grant: z
      .object({
        grantId: BrowserReferenceSchema,
        revision: BrowserCounterSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export const BrowserCanvasDetachSchema = z
  .object({ attachmentId: BrowserReferenceSchema })
  .strict();
export const BrowserCanvasDeliveryReceiptSchema = z
  .object({
    owner: z.boolean(),
    binding: BrowserBindingSchema,
    grant: BrowserCanvasDeliverySchema.shape.grant,
  })
  .strict();
export { CanvasDocumentSchema as BrowserCanvasPresentReceiptSchema };
export type BrowserCanvasPresent = z.infer<typeof BrowserCanvasPresentSchema>;
export type BrowserCanvasShare = z.infer<typeof BrowserCanvasShareSchema>;
export type BrowserCanvasDelivery = z.infer<typeof BrowserCanvasDeliverySchema>;
export type BrowserCanvasDeliveryReceipt = z.infer<typeof BrowserCanvasDeliveryReceiptSchema>;
