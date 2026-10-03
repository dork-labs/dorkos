/** Pure capture schema construction from the authoritative existing binding/frame schemas. */
import { z } from 'zod';
import { boundedBrowserJson, BrowserCounterSchema as counter } from './browser-schema-json.js';
const dimension = z.number().int().min(1).max(16384);
const positive = z.number().finite().positive();
const common = { sequence: counter, atOffsetMs: counter };
const method = z.enum([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'other',
  'unknown',
]);
const resource = z.enum([
  'document',
  'script',
  'style',
  'image',
  'font',
  'fetch',
  'media',
  'other',
  'unknown',
]);
const status = z.enum([
  'informational',
  'success',
  'redirect',
  'clientError',
  'serverError',
  'unknown',
]);
const duration = z.enum(['under100ms', 'under1s', 'under10s', 'atLeast10s', 'unknown']);
const entry = z.discriminatedUnion('category', [
  z
    .object({
      ...common,
      category: z.literal('console'),
      severity: z.enum(['debug', 'info', 'warning', 'error', 'unknown']),
    })
    .strict(),
  z
    .object({ ...common, category: z.literal('error'), severity: z.enum(['error', 'unknown']) })
    .strict(),
  z
    .object({
      ...common,
      category: z.literal('network'),
      requestId: z.string().regex(/^request_[0-9]{16}$/u),
      method,
      resource,
      status: status.optional(),
      duration: duration.optional(),
    })
    .strict(),
  z.object({ ...common, category: z.literal('lifecycle') }).strict(),
]);
/** Preserve precise schema outputs with no runtime import back into the facade. */
export function createBrowserCaptureSchemas<
  B extends z.ZodType,
  F extends z.ZodType<{ width: number; height: number; format: 'jpeg' | 'png' }>,
>(schemas: { binding: B; frame: F }) {
  const pointer = z
    .object({
      x: z.number().finite().nonnegative(),
      y: z.number().finite().nonnegative(),
      revision: counter,
    })
    .strict()
    .nullable();
  const geometry = z
    .object({
      cssViewport: z.object({ width: dimension, height: dimension }).strict(),
      raster: z
        .object({ width: dimension, height: dimension, format: z.enum(['jpeg', 'png']) })
        .strict(),
      scaleX: positive,
      scaleY: positive,
    })
    .strict();
  const BrowserFramePointerEnvelopeSchema = boundedBrowserJson(
    z
      .object({ frame: schemas.frame, geometry, pointer })
      .strict()
      .refine((value) => {
        const { cssViewport: c, raster: r, scaleX, scaleY } = value.geometry;
        const frame = schemas.frame.parse(Object.getOwnPropertyDescriptor(value, 'frame')?.value);
        return (
          frame.width === c.width &&
          frame.height === c.height &&
          frame.format === r.format &&
          scaleX === r.width / c.width &&
          scaleY === r.height / c.height &&
          r.width * r.height <= 8388608 &&
          (!value.pointer || (value.pointer.x < c.width && value.pointer.y < c.height))
        );
      })
  );
  const BrowserDiagnosticSummarySchema = boundedBrowserJson(
    z
      .object({
        binding: schemas.binding,
        interval: z.object({ startOffsetMs: counter, endOffsetMs: counter }).strict(),
        entries: z.array(entry).max(256),
        counts: z
          .object({
            dropped: counter,
            truncated: counter,
            correlationDropped: counter,
            unmatchedCallbacks: counter,
          })
          .strict(),
        terminal: z.enum(['none', 'counterExhausted', 'observerUnavailable', 'ownerCapacity']),
        lastAccountedSequence: counter,
        subsequentEventsUncounted: z.boolean(),
      })
      .strict()
      .refine((value) => {
        if (
          value.interval.endOffsetMs < value.interval.startOffsetMs ||
          value.subsequentEventsUncounted !== (value.terminal !== 'none')
        )
          return false;
        let sequence = -1,
          offset = value.interval.startOffsetMs;
        for (const e of value.entries) {
          if (
            e.sequence <= sequence ||
            e.sequence > value.lastAccountedSequence ||
            e.atOffsetMs < offset ||
            e.atOffsetMs > value.interval.endOffsetMs
          )
            return false;
          sequence = e.sequence;
          offset = e.atOffsetMs;
        }
        return true;
      }),
    266240
  );
  return { BrowserFramePointerEnvelopeSchema, BrowserDiagnosticSummarySchema };
}
