/** Strict, transport-independent document channel contracts. No transport is enabled here. */
import { z } from 'zod';

/** Maximum serialized UTF-8 bytes in an event or state-patch envelope. */
export const CANVAS_CHANNEL_ENVELOPE_BYTES = 16 * 1024;
/** Maximum container nesting in channel JSON. */
export const CANVAS_CHANNEL_JSON_DEPTH = 32;
/** Maximum serialized bytes of a document's separate live state. */
export const CANVAS_CHANNEL_STATE_BYTES = 256 * 1024;

/** Finite, plain JSON data carried by channel events and state. */
export type CanvasChannelJsonValue =
  | string
  | number
  | boolean
  | null
  | CanvasChannelJsonValue[]
  | { [key: string]: CanvasChannelJsonValue };

/** Prototype-sensitive property names refused before parsing. @internal */
export const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const encoder = new TextEncoder();

function containerEntries(value: object): [string, unknown][] | undefined {
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) return undefined;
  } else if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length) return undefined;
  const keys = Array.isArray(value)
    ? Array.from({ length: value.length }, (_, index) => String(index))
    : Object.keys(descriptors);
  if (Array.isArray(value) && Object.keys(descriptors).length !== value.length + 1)
    return undefined;
  const entries: [string, unknown][] = [];
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (unsafeKeys.has(key) || !descriptor || !('value' in descriptor) || !descriptor.enumerable)
      return undefined;
    entries.push([key, descriptor.value]);
  }
  return entries;
}

/**
 * Inspect raw JSON iteratively, before Zod or JSON.stringify can recurse.
 * Accessors, exotic prototypes, sparse arrays, cycles and unsafe keys fail closed.
 * Aliased objects are legal when they are not ancestors of themselves.
 */
export function inspectCanvasChannelJson(
  value: unknown,
  maxBytes = CANVAS_CHANNEL_ENVELOPE_BYTES
): string | undefined {
  const pending: { value: unknown; depth: number; exit?: boolean }[] = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  let bytes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    const current = item.value;
    if (item.exit) {
      ancestors.delete(current as object);
      continue;
    }
    if (current !== null && typeof current === 'object') {
      if (item.depth > CANVAS_CHANNEL_JSON_DEPTH) return 'JSON exceeds the maximum depth';
      if (ancestors.has(current)) return 'JSON must not contain cycles';
      // A huge array can be refused before enumerating or allocating its entries.
      if (Array.isArray(current) && current.length > maxBytes) return 'JSON exceeds the byte limit';
      const entries = containerEntries(current);
      if (!entries) return 'Expected plain JSON without unsafe keys or accessors';
      bytes += 2 + Math.max(0, entries.length - 1);
      ancestors.add(current);
      pending.push({ value: current, depth: item.depth, exit: true });
      for (const [key, child] of entries) {
        if (!Array.isArray(current)) bytes += encoder.encode(JSON.stringify(key)).length + 1;
        pending.push({ value: child, depth: item.depth + 1 });
      }
    } else {
      if (typeof current === 'number' && !Number.isFinite(current))
        return 'Expected finite JSON numbers';
      if (current !== null && !['string', 'number', 'boolean'].includes(typeof current))
        return 'Expected JSON data';
      bytes += encoder.encode(JSON.stringify(current)).length;
    }
    if (bytes > maxBytes) return 'JSON exceeds the byte limit';
  }
  return undefined;
}

/** Recursive JSON shape used only behind an iterative preflight. @internal */
export const RecursiveJsonSchema: z.ZodType<CanvasChannelJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(RecursiveJsonSchema),
    z.object({}).catchall(RecursiveJsonSchema),
  ])
);

/** Place a raw iterative preflight before recursive schema parsing. @internal */
export function boundedJson<S extends z.ZodType>(
  schema: S,
  maxBytes = CANVAS_CHANNEL_ENVELOPE_BYTES
) {
  return z.preprocess((value, context) => {
    const problem = inspectCanvasChannelJson(value, maxBytes);
    if (problem) {
      context.addIssue({ code: 'custom', message: problem });
      return z.NEVER;
    }
    return value;
  }, schema);
}

/** Bounded JSON value; object catchall preserves SDK tool-schema compatibility. */
export const CanvasChannelJsonValueSchema = boundedJson(RecursiveJsonSchema);
/** Bounded live state object, independent of editable document content. */
export const CanvasChannelStateSchema = boundedJson(
  z.object({}).catchall(RecursiveJsonSchema),
  CANVAS_CHANNEL_STATE_BYTES
);
