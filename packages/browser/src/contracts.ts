import { z } from 'zod';
import { BrowserIdSchema, ProfileIdSchema, RequestIdSchema, TabIdSchema } from './ids.js';
import { CounterSchema } from './counters.js';
import { parseValidated } from './validation.js';

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 8192;
const MAX_COORDINATE = 16384;
const coordinate = z.number().finite().min(0).max(MAX_COORDINATE);
const text = z
  .string()
  .max(MAX_TEXT_BYTES)
  .refine((value) => Buffer.byteLength(value) <= MAX_TEXT_BYTES);
const compositionText = z
  .string()
  .max(2048)
  .refine(
    (value) =>
      Buffer.byteLength(value) <= 2048 &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
  );
const BindingSchema = z
  .object({
    browserId: BrowserIdSchema,
    browserGeneration: CounterSchema,
    tabId: TabIdSchema,
    navigationGeneration: CounterSchema,
    viewportVersion: CounterSchema,
    epoch: CounterSchema,
    inputGeneration: CounterSchema,
  })
  .strict();
const button = z.enum(['left', 'middle', 'right']);
const key = z.enum([
  'Tab',
  'Enter',
  'Space',
  'Escape',
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Backspace',
  'Delete',
]);
const StepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), x: coordinate, y: coordinate, button }).strict(),
  z.object({ kind: z.literal('mouseMove'), x: coordinate, y: coordinate }).strict(),
  z.object({ kind: z.literal('mouseDown'), button }).strict(),
  z.object({ kind: z.literal('mouseUp'), button }).strict(),
  z.object({ kind: z.literal('keyDown'), key }).strict(),
  z.object({ kind: z.literal('keyUp'), key }).strict(),
  z.object({ kind: z.literal('text'), text }).strict(),
  z
    .object({
      kind: z.literal('composition'),
      text: compositionText,
      selectionStart: z.number().int().nonnegative().max(2048),
      selectionEnd: z.number().int().nonnegative().max(2048),
    })
    .strict()
    .refine(
      (value) =>
        value.selectionStart <= value.selectionEnd && value.selectionEnd <= value.text.length
    ),
  z.object({ kind: z.literal('compositionCommit'), text: compositionText }).strict(),
  z
    .object({
      kind: z.literal('wheel'),
      deltaX: z.number().finite().min(-MAX_COORDINATE).max(MAX_COORDINATE),
      deltaY: z.number().finite().min(-MAX_COORDINATE).max(MAX_COORDINATE),
    })
    .strict(),
]);
const navigationUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    if (value === 'about:blank') return true;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  });
const CommandSchema = z.union([
  z
    .object({
      kind: z.literal('open'),
      requestId: RequestIdSchema,
      mode: z.literal('persistent'),
      profileId: ProfileIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('open'),
      requestId: RequestIdSchema,
      mode: z.literal('ephemeral'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('input'),
      requestId: RequestIdSchema,
      binding: BindingSchema,
      steps: z.array(StepSchema).min(1).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal('navigate'),
      requestId: RequestIdSchema,
      binding: BindingSchema,
      url: navigationUrl,
    })
    .strict(),
  z
    .object({
      kind: z.literal('capture'),
      requestId: RequestIdSchema,
      binding: BindingSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('close'),
      requestId: RequestIdSchema,
      browserId: BrowserIdSchema,
      browserGeneration: CounterSchema,
    })
    .strict(),
]);
const reason = z.enum([
  'staleBinding',
  'stopped',
  'deadline',
  'dispatchFailed',
  'responseLost',
  'networkPolicyUnsupported',
  'policyRefused',
]);
const openedFields = {
  kind: z.literal('opened'),
  requestId: RequestIdSchema,
  browserId: BrowserIdSchema,
  browserGeneration: CounterSchema,
  tab: BindingSchema,
};
const OpenedSchema = z
  .discriminatedUnion('mode', [
    z
      .object({
        ...openedFields,
        mode: z.literal('persistent'),
        profileId: ProfileIdSchema,
      })
      .strict(),
    z.object({ ...openedFields, mode: z.literal('ephemeral') }).strict(),
  ])
  .refine(
    (value) =>
      value.tab.browserId === value.browserId &&
      value.tab.browserGeneration === value.browserGeneration
  );
const closeFields = {
  kind: z.literal('close'),
  requestId: RequestIdSchema,
  browserId: BrowserIdSchema,
  browserGeneration: CounterSchema,
};
const ResultSchema = z.union([
  OpenedSchema,
  z.object({ ...closeFields, cleanup: z.literal('observed') }).strict(),
  z
    .object({
      ...closeFields,
      cleanup: z.enum(['failed', 'unverified']),
      reason: z.enum(['processesRemain', 'observationUnavailable', 'closeFailed']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('action'),
      requestId: RequestIdSchema,
      binding: BindingSchema,
      outcome: z.literal('completed'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('action'),
      requestId: RequestIdSchema,
      binding: BindingSchema,
      outcome: z.enum(['rejected', 'aborted', 'uncertain']),
      reason,
    })
    .strict(),
  z
    .object({
      kind: z.literal('frame'),
      rasterWidth: z.number().int().min(1).max(MAX_COORDINATE),
      rasterHeight: z.number().int().min(1).max(MAX_COORDINATE),
      pointer: z
        .object({ x: coordinate, y: coordinate, revision: CounterSchema })
        .strict()
        .nullable(),
      binding: BindingSchema,
      captureSequence: CounterSchema,
      width: z.number().int().min(1).max(MAX_COORDINATE),
      height: z.number().int().min(1).max(MAX_COORDINATE),
      byteLength: z.number().int().min(1).max(MAX_FRAME_BYTES),
      format: z.enum(['jpeg', 'png']),
    })
    .strict()
    .refine(
      (frame) =>
        frame.rasterWidth * frame.rasterHeight <= 8 * 1024 * 1024 &&
        (!frame.pointer || (frame.pointer.x < frame.width && frame.pointer.y < frame.height))
    ),
]);

/** Exact live Page/control identities; IDs alone grant no authority. */
export type BrowserBinding = z.infer<typeof BindingSchema>;
/** Bounded manager input, deliberately excluding selectors and evaluation. */
export type BrowserInputStep = z.infer<typeof StepSchema>;
/** Validated engine commands; no lifecycle implementation is exposed by this slice. */
export type BrowserCommand = z.infer<typeof CommandSchema>;
/** Attributed outcomes or capture metadata, never captured page contents or input echoes. */
export type BrowserResult = z.infer<typeof ResultSchema>;

/** Validate a command structurally; dispatch must separately recheck lifecycle and policy. */
export function parseBrowserCommand(value: unknown): BrowserCommand {
  return parseValidated(CommandSchema, value, 'INVALID_COMMAND');
}
/** Validate result metadata without implying a browser operation or durable write occurred. */
export function parseBrowserResult(value: unknown): BrowserResult {
  return parseValidated(ResultSchema, value, 'INVALID_RESULT');
}

/** Parse only the existing seven-field binding; this trusted seam does not grant controller authority. */
export function parseBrowserBinding(value: unknown): BrowserBinding {
  return parseValidated(BindingSchema, value, 'INVALID_COMMAND');
}

const UploadSchema = z
  .object({
    kind: z.literal('upload'),
    requestId: RequestIdSchema,
    binding: BindingSchema,
    artifactId: z
      .string()
      .min(22)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    activation: z.object({ x: coordinate, y: coordinate }).strict(),
  })
  .strict();
export type BrowserUpload = z.infer<typeof UploadSchema>;
/** Private upload parsing grants no permission and accepts no path/selector/protocol operation. */
export function parseBrowserUpload(value: unknown): BrowserUpload {
  return parseValidated(UploadSchema, value, 'INVALID_COMMAND');
}

const DownloadSchema = UploadSchema.omit({ artifactId: true })
  .extend({ kind: z.literal('download') })
  .strict();
export type BrowserDownload = z.infer<typeof DownloadSchema>;
/** Private response transfer parsing conveys neither permissions nor filesystem paths. */
export function parseBrowserDownload(value: unknown): BrowserDownload {
  return parseValidated(DownloadSchema, value, 'INVALID_COMMAND');
}

const CopySelectionSchema = z
  .object({ requestId: RequestIdSchema, binding: BindingSchema })
  .strict();
/** Constructor-private read request; binding metadata supplies no authority. */
export function parseCopySelectionRequest(value: unknown) {
  return parseValidated(CopySelectionSchema, value, 'INVALID_COMMAND');
}
