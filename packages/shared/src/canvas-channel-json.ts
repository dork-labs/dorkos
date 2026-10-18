/** Strict, transport-independent document channel contracts. No transport is enabled here. */
import { z } from 'zod';
import {
  UNSAFE_JSON_KEYS,
  inspectBoundedJson,
  jsonValueUnion,
  withJsonBounds,
  type JsonValue,
} from './bounded-json.js';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/** Maximum serialized UTF-8 bytes in an event or state-patch envelope. */
export const CANVAS_CHANNEL_ENVELOPE_BYTES = 16 * 1024;
/** Maximum container nesting in channel JSON. */
export const CANVAS_CHANNEL_JSON_DEPTH = 32;
/** Maximum serialized bytes of a document's separate live state. */
export const CANVAS_CHANNEL_STATE_BYTES = 256 * 1024;

/** Finite, plain JSON data carried by channel events and state. */
export type CanvasChannelJsonValue = JsonValue;

/** Prototype-sensitive property names refused before parsing. @internal */
export const unsafeKeys = UNSAFE_JSON_KEYS;

/**
 * Inspect raw JSON iteratively, before Zod or JSON.stringify can recurse.
 * Accessors, exotic prototypes, sparse arrays, cycles and unsafe keys fail closed.
 * Aliased objects are legal when they are not ancestors of themselves.
 */
export function inspectCanvasChannelJson(
  value: unknown,
  maxBytes = CANVAS_CHANNEL_ENVELOPE_BYTES
): string | undefined {
  return inspectBoundedJson(value, { maxBytes, maxDepth: CANVAS_CHANNEL_JSON_DEPTH });
}

/** Recursive JSON shape used only behind an iterative preflight. @internal */
export const RecursiveJsonSchema: z.ZodType<CanvasChannelJsonValue> = z
  .lazy(() => jsonValueUnion(RecursiveJsonSchema))
  .openapi('CanvasChannelJson');

/** Place a raw iterative preflight before recursive schema parsing. @internal */
export function boundedJson<S extends z.ZodType>(
  schema: S,
  maxBytes = CANVAS_CHANNEL_ENVELOPE_BYTES
) {
  return withJsonBounds(schema, { maxBytes, maxDepth: CANVAS_CHANNEL_JSON_DEPTH });
}

/** Bounded JSON value; object catchall preserves SDK tool-schema compatibility. */
export const CanvasChannelJsonValueSchema = boundedJson(RecursiveJsonSchema);
/** Bounded live state object, independent of editable document content. */
export const CanvasChannelStateSchema = boundedJson(
  z.object({}).catchall(RecursiveJsonSchema),
  CANVAS_CHANNEL_STATE_BYTES
);
