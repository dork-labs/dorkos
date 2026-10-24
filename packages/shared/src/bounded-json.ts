/**
 * Plain JSON with limits measured, never trusted: a value is inspected
 * iteratively (bytes of its own serialization, nesting depth, cycles, unsafe
 * keys, accessors, exotic prototypes) before any recursive schema touches it.
 * The canvas channel and the session relay both build on it, each with its own
 * byte and depth limits.
 *
 * @module shared/bounded-json
 */
import { z } from 'zod';

/** Finite, plain JSON data. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** The limits one bounded JSON value is held to. */
export interface JsonBounds {
  /** Most UTF-8 bytes of the value's serialization. */
  maxBytes: number;
  /** Most container nesting; the top-level value is depth 0. */
  maxDepth: number;
}

/** Prototype-sensitive property names refused before parsing. */
export const UNSAFE_JSON_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

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
    if (
      UNSAFE_JSON_KEYS.has(key) ||
      !descriptor ||
      !('value' in descriptor) ||
      !descriptor.enumerable
    )
      return undefined;
    entries.push([key, descriptor.value]);
  }
  return entries;
}

/**
 * Inspect raw JSON iteratively, before Zod or JSON.stringify can recurse, and
 * name the first problem, or `undefined` when there is none. Accessors, exotic
 * prototypes, sparse arrays, cycles and unsafe keys fail closed. Aliased
 * objects are legal when they are not ancestors of themselves.
 *
 * @param value - The raw value.
 * @param bounds - The byte and depth limits.
 */
export function inspectBoundedJson(value: unknown, bounds: JsonBounds): string | undefined {
  const { maxBytes, maxDepth } = bounds;
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
      if (item.depth > maxDepth) return 'JSON exceeds the maximum depth';
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

/**
 * The union one level of a recursive JSON schema is made of, around `self`.
 * A caller that labels its schema (the canvas channel's OpenAPI name) builds
 * its own `z.lazy` around this, so the label sits on the recursion itself.
 *
 * @param self - The recursive schema, referenced lazily.
 */
export function jsonValueUnion(self: z.ZodType<JsonValue>) {
  return z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(self),
    z.object({}).catchall(self),
  ]);
}

/** Recursive JSON, unlabelled. Use only behind {@link withJsonBounds}. */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => jsonValueUnion(JsonValueSchema));

/** A plain JSON object of {@link JsonValueSchema} values. Use only behind {@link withJsonBounds}. */
export const JsonObjectSchema = z.object({}).catchall(JsonValueSchema);

/**
 * Put the iterative inspection in front of `schema`, so a value past its
 * bounds is refused before any recursive parse, and never cut.
 *
 * @param schema - The schema for the value once it is known to be bounded.
 * @param bounds - The byte and depth limits.
 */
export function withJsonBounds<S extends z.ZodType>(schema: S, bounds: JsonBounds) {
  return z.preprocess((value, context) => {
    const problem = inspectBoundedJson(value, bounds);
    if (problem) {
      context.addIssue({ code: 'custom', message: problem });
      return z.NEVER;
    }
    return value;
  }, schema);
}

/**
 * UTF-8 bytes of a value's JSON serialization, or `Infinity` when it has none.
 * For a value that already parsed, so it cannot cycle.
 *
 * @param value - The parsed value.
 */
export function jsonByteLength(value: unknown): number {
  const text = JSON.stringify(value);
  return text === undefined ? Infinity : encoder.encode(text).length;
}
