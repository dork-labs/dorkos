import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';
extendZodWithOpenApiOnce();

/** Epoch milliseconds. Missing means unknown; observation times are not network dispatch times. */
export const TimingFields = {
  startedAt: z.number().int().nonnegative().optional(),
  endedAt: z.number().int().nonnegative().optional(),
};

/**
 * One model request, updated under its native request id when available.
 * `usage` may have no id when a runtime exposes a per-request reading without identity.
 * First-token/end times are local observations unless the runtime supplies native times.
 * A response-start notification never supplies a guessed request startedAt.
 * Counts follow native accounting; Claude/OpenCode input includes their separate cache buckets.
 */
export const ModelRequestEventSchema = z
  .object({
    requestId: z.string().optional(),
    phase: z.enum(['start', 'first_token', 'end', 'usage']),
    ...TimingFields,
    firstTokenAt: z.number().int().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    model: z.string().optional(),
  })
  .openapi('ModelRequestEvent');

/** Per-request timing and token counts, never aggregate turn totals. */
export type ModelRequestEvent = z.infer<typeof ModelRequestEventSchema>;

export const TextDeltaSchema = z
  .object({
    text: z.string(),
  })
  .openapi('TextDelta');

export type TextDelta = z.infer<typeof TextDeltaSchema>;

export const ThinkingDeltaSchema = z
  .object({
    text: z.string(),
  })
  .openapi('ThinkingDelta');

export type ThinkingDelta = z.infer<typeof ThinkingDeltaSchema>;

export const ToolProgressEventSchema = z
  .object({
    toolCallId: z.string(),
    content: z.string(),
  })
  .openapi('ToolProgressEvent');

export type ToolProgressEvent = z.infer<typeof ToolProgressEventSchema>;
