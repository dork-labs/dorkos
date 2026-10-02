/** Browser-safe bounded JSON preflight; it certifies shape, never page trust or authority. */
import { z } from 'zod';

const encoder = new TextEncoder();

/** UTF-8 byte count without a Node dependency. */
export const browserUtf8Bytes = (value: string): number => encoder.encode(value).length;

/** Reject cycles, accessors, sparse arrays and oversized envelopes before Zod traversal. */
export function boundedBrowserJson<S extends z.ZodType>(schema: S, maxBytes = 16 * 1024) {
  return z.preprocess((value, context) => {
    const ancestors = new Set<object>();
    let bytes = 0;
    let entries = 0;
    function inspect(item: unknown, depth: number): boolean {
      if (++entries > maxBytes || depth > 40) return false;
      if (item === null || typeof item === 'boolean' || typeof item === 'number') {
        if (typeof item === 'number' && !Number.isFinite(item)) return false;
        bytes += browserUtf8Bytes(JSON.stringify(item));
      } else if (typeof item === 'string') {
        if (item.length > maxBytes) return false;
        bytes += browserUtf8Bytes(JSON.stringify(item));
      } else if (typeof item === 'object') {
        const array = Array.isArray(item);
        if (ancestors.has(item)) return false;
        if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype))
          return false;
        if (array && item.length > maxBytes) return false;
        const keys = Reflect.ownKeys(item);
        if (keys.length > maxBytes || (array && keys.length !== item.length + 1)) return false;
        ancestors.add(item);
        bytes += 2 + Math.max(0, keys.length - (array ? 2 : 1));
        for (const key of keys) {
          if (array && key === 'length') continue;
          if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))
            return false;
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false;
          if (array && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length)) return false;
          if (!array) bytes += browserUtf8Bytes(JSON.stringify(key)) + 1;
          if (bytes > maxBytes || !inspect(descriptor.value, depth + 1)) return false;
        }
        ancestors.delete(item);
      } else return false;
      return bytes <= maxBytes;
    }
    try {
      if (inspect(value, 0)) return value;
    } catch {
      // Exotic caller objects do not establish valid wire data.
    }
    context.addIssue({ code: 'custom', message: 'Expected bounded plain browser JSON' });
    return z.NEVER;
  }, schema);
}

/** Nonnegative counters stop at the maximum safe integer. */
export const BrowserCounterSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Random-reference encoding bounds; randomness and issuance require server validation. */
export const BrowserReferenceSchema = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/u);
/** Informational UTC timestamp, never a lease-expiry authority. */
export const BrowserTimestampSchema = z.string().datetime();

/** Bound valid Unicode without truncating a surrogate or text commit. */
export function browserText(maxBytes: number) {
  return z
    .string()
    .max(maxBytes)
    .refine(
      (value) =>
        browserUtf8Bytes(value) <= maxBytes &&
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
    );
}

/** Output text must already have normalized newlines and removed unsafe controls. */
export function browserPlainText(maxBytes: number) {
  return browserText(maxBytes).refine(
    (value) =>
      ![...value].some((char) => {
        const code = char.charCodeAt(0);
        return (
          code < 9 ||
          (code > 10 && code < 32) ||
          (code >= 127 && code <= 159) ||
          (code >= 0x202a && code <= 0x202e) ||
          (code >= 0x2066 && code <= 0x2069)
        );
      })
  );
}
