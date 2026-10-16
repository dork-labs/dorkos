/** Ordinary file writes and optional host-generated saved receipts. */
import { z } from 'zod';
import { CanvasDocIncarnationSchema } from '../canvas-doc-incarnation.js';
import { CanvasChannelEventIdSchema } from '../canvas-channel-schemas.js';
import { extendZodWithOpenApiOnce } from '../zod-openapi.js';

extendZodWithOpenApiOnce();

// JSON Schema has no RegExp flags. Keep these overrides private to the file-save docs;
// .openapi returns a metadata clone and leaves the shared runtime schemas untouched.
const FileSaveEventIdSchema = CanvasChannelEventIdSchema.openapi({
  pattern: '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$',
});
const FileSaveHashPattern = /^[a-f0-9]{64}$/u;
const FileSaveIncarnationSchema = CanvasDocIncarnationSchema.extend({
  generation: z.string().regex(FileSaveHashPattern).openapi({
    pattern: FileSaveHashPattern.source,
  }),
});

/** Page-supplied correlation and expected birth; neither grants document authority. */
export const FileDocumentSaveRequestSchema = z
  .object({
    documentId: z.string().min(1).max(200),
    eventId: FileSaveEventIdSchema,
    incarnation: FileSaveIncarnationSchema,
  })
  .strict()
  .refine((value) => value.documentId === value.incarnation.documentId, {
    message: 'Document and expected incarnation must match',
  })
  .openapi('FileDocumentSaveRequest');

/** Durable proof of this original file replacement, without route-delivery claims. */
export const FileDocumentSaveReceiptSchema = z
  .object({
    documentId: z.string().min(1).max(200),
    eventId: FileSaveEventIdSchema,
    incarnation: FileSaveIncarnationSchema,
    docSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    fileHash: z
      .string()
      .regex(FileSaveHashPattern)
      .openapi({ pattern: FileSaveHashPattern.source }),
    status: z.enum(['accepted', 'duplicate']),
  })
  .strict()
  .refine((value) => value.documentId === value.incarnation.documentId, {
    message: 'Receipt and document incarnation must match',
  })
  .openapi('FileDocumentSaveReceipt');

/** Existing-file writes remain usable without a document receipt request. */
export const WriteFileRequestSchema = z
  .object({
    cwd: z.string().min(1),
    path: z.string().min(1),
    content: z.string(),
    expectedHash: z.string().optional(),
    expectedContent: z.string().optional(),
    documentSave: FileDocumentSaveRequestSchema.optional(),
  })
  .refine(
    (value) =>
      !value.documentSave ||
      value.expectedHash !== undefined ||
      value.expectedContent !== undefined,
    {
      message: 'Document saves require a content baseline',
    }
  )
  .openapi('WriteFileRequest');
export type WriteFileRequest = z.infer<typeof WriteFileRequestSchema>;

/** Ordinary saves do not imply a receipt; only the original document operation can return one. */
export const WriteFileResponseSchema = z
  .object({
    ok: z.literal(true),
    hash: z.string(),
    effect: z.enum(['changed', 'no_op']).optional(),
    documentReceipt: FileDocumentSaveReceiptSchema.optional(),
  })
  .openapi('WriteFileResponse');
export type WriteFileResponse = z.infer<typeof WriteFileResponseSchema>;
export type FileDocumentSaveRequest = z.infer<typeof FileDocumentSaveRequestSchema>;
export type FileDocumentSaveReceipt = z.infer<typeof FileDocumentSaveReceiptSchema>;
