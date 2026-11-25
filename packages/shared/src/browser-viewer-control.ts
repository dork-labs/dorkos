import { z } from 'zod';

const coordinate = z.number().finite().min(0).max(100_000);
const delta = z.number().finite().min(-100_000).max(100_000);
const button = z.enum(['left', 'middle', 'right', 'none']);
const modifiers = z.number().int().min(0).max(15);
/** App-only finite inputs. No protocol command, target or expression is accepted. */
export const browserViewerInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('pointer'),
      type: z.enum(['mouseMoved', 'mousePressed', 'mouseReleased']),
      x: coordinate,
      y: coordinate,
      button,
      clickCount: z.number().int().min(0).max(3),
      modifiers: modifiers.default(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal('wheel'),
      x: coordinate,
      y: coordinate,
      deltaX: delta,
      deltaY: delta,
    })
    .strict(),
  z
    .object({
      kind: z.literal('key'),
      type: z.enum(['keyDown', 'keyUp']),
      key: z.string().min(1).max(64),
      code: z.string().max(64),
      modifiers,
    })
    .strict(),
  z
    .object({
      kind: z.literal('touch'),
      type: z.enum(['touchStart', 'touchMove', 'touchEnd', 'touchCancel']),
      points: z
        .array(
          z.object({ x: coordinate, y: coordinate, id: z.number().int().min(0).max(31) }).strict()
        )
        .max(10),
    })
    .strict(),
  z.object({ kind: z.literal('text'), text: z.string().max(2_048) }).strict(),
  z
    .object({
      kind: z.literal('composition'),
      text: z.string().max(2_048),
      selectionStart: z.number().int().min(0).max(2_048),
      selectionEnd: z.number().int().min(0).max(2_048),
    })
    .strict(),
]);
export type BrowserViewerInput = z.input<typeof browserViewerInputSchema>;
export interface BrowserViewerChooser {
  id: string;
  host: string;
  multiple: boolean;
  navigationGeneration: number;
}

/** Opaque authority travels only beside its original cookie and app-instance proof. */
export const viewerSecretSchema = z.string().regex(/^[\w-]{43}$/);
const generation = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const viewerControlRefSchema = z
  .object({
    nonce: viewerSecretSchema,
    controllerId: viewerSecretSchema,
    controlEpoch: generation,
  })
  .strict();
export const viewerOperationSchema = viewerControlRefSchema
  .extend({
    navigationGeneration: generation,
    viewportGeneration: generation.min(1),
    sequence: generation.min(1),
  })
  .strict();
export type BrowserViewerOperation = z.infer<typeof viewerOperationSchema>;
export const viewerPaintSchema = z
  .object({
    addressReceipt: viewerSecretSchema,
    viewportGeneration: generation.min(1),
  })
  .strict();
export type BrowserViewerPaint = z.infer<typeof viewerPaintSchema>;
export const viewerViewportSchema = z
  .object({
    generation: generation.min(1),
    width: z.number().finite().positive().max(100_000),
    height: z.number().finite().positive().max(100_000),
    offsetTop: z.number().finite().min(0).max(100_000),
    scale: z.number().finite().positive().max(100),
  })
  .strict();
export type BrowserViewerViewport = z.infer<typeof viewerViewportSchema>;
export const viewerMetadataSchema = z
  .object({
    revision: generation,
    navigationGeneration: generation,
    controlEpoch: generation,
    viewport: viewerViewportSchema.nullable(),
    control: z
      .object({
        id: viewerSecretSchema,
        epoch: generation,
        ready: z.boolean(),
        nextSequence: generation.min(1),
      })
      .strict()
      .nullable(),
    chooser: z
      .object({
        id: viewerSecretSchema,
        host: z.string().min(1).max(255),
        multiple: z.boolean(),
        navigationGeneration: generation,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type BrowserViewerMetadata = z.infer<typeof viewerMetadataSchema>;
export const viewerOutcomeSchema = z
  .object({
    sequence: generation.min(1),
    status: z.enum(['done', 'refused', 'uncertain']),
    code: z
      .enum([
        'viewer_denied',
        'viewer_busy',
        'viewer_limit',
        'viewer_stale',
        'viewer_uncertain',
        'file_picker_stuck',
      ])
      .optional(),
  })
  .strict();
export type BrowserViewerOutcome = z.infer<typeof viewerOutcomeSchema>;
