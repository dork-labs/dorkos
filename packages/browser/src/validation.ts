import type { z } from 'zod';
import { BrowserValidationError, type BrowserValidationCode } from './errors.js';

const MAX_DEPTH = 16;
const MAX_ENTRIES = 2048;
const MAX_BYTES = 16 * 1024;

/** Bound traversal before schema parsing, refusing cycles, holes and getters without invoking them. */
function inspect(value: unknown, allowFunctions: boolean): boolean {
  let entries = 0;
  let stringBytes = 0;
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): boolean {
    if (++entries > MAX_ENTRIES || depth > MAX_DEPTH) return false;
    if (typeof item === 'string') {
      if (item.length > MAX_BYTES) return false;
      stringBytes += Buffer.byteLength(item);
      return stringBytes <= MAX_BYTES;
    }
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'function') return allowFunctions;
    if (typeof item !== 'object' || seen.has(item)) return false;
    seen.add(item);
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype)) return false;
    const keys = Reflect.ownKeys(item);
    if (keys.length > MAX_ENTRIES) return false;
    if (array && keys.length !== item.length + 1) return false;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return false;
      stringBytes += Buffer.byteLength(key);
      if (stringBytes > MAX_BYTES) return false;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false;
      if (array && !/^(0|[1-9]\d*)$/.test(key)) return false;
      if (!visit(descriptor.value, depth + 1)) return false;
    }
    return true;
  }
  return visit(value, 0);
}

/** Internal parser shared by the complete exported validators. */
export function parseValidated<S extends z.ZodType>(
  schema: S,
  value: unknown,
  code: BrowserValidationCode,
  allowFunctions = false
): z.output<S> {
  try {
    if (
      !inspect(value, allowFunctions) ||
      (!allowFunctions && Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES)
    ) {
      throw new BrowserValidationError(code);
    }
    const result = schema.safeParse(value);
    if (!result.success) throw new BrowserValidationError(code);
    return result.data;
  } catch {
    throw new BrowserValidationError(code);
  }
}
