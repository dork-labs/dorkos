import { EnvelopeError, textBytes } from './scanner.js';

/** Producer attestation is fixture-only: bounds must hold before this traversal starts. */
export interface PreboundedData {
  readonly value: unknown;
  readonly producer: 'fixture-prebounded-own-data';
}
/** Reject accessors/sparse arrays/exotic data under an already prebounded producer capability. */
export function inspectOwnData(
  value: unknown,
  check: () => void,
  memberCap = 256,
  textCap = 65536
): void {
  let members = 0;
  let bytes = 0;
  const visited = new Set<object>();
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (pending.length) {
    check();
    const item = pending.pop()!;
    const v = item.value;
    if (typeof v === 'string') {
      bytes += textBytes(v);
      if (bytes > textCap) throw new EnvelopeError('BUDGET_EXCEEDED');
      continue;
    }
    if (v === null || typeof v === 'boolean') continue;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new EnvelopeError('INVALID_ENVELOPE');
      continue;
    }
    if (typeof v !== 'object' || item.depth > 16) throw new EnvelopeError('INVALID_ENVELOPE');
    if (visited.has(v)) throw new EnvelopeError('INVALID_ENVELOPE');
    visited.add(v);
    const proto = Object.getPrototypeOf(v);
    check();
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== null)
      throw new EnvelopeError('INVALID_ENVELOPE');
    const keys = Reflect.ownKeys(v);
    check();
    if (Array.isArray(v)) {
      const length = Object.getOwnPropertyDescriptor(v, 'length');
      check();
      if (
        !length ||
        !('value' in length) ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0 ||
        length.value > memberCap ||
        keys.length !== length.value + 1
      )
        throw new EnvelopeError('INVALID_ENVELOPE');
      for (let i = 0; i < length.value; i++)
        if (!keys.includes(String(i))) throw new EnvelopeError('INVALID_ENVELOPE');
    }
    for (const key of keys) {
      check();
      if (Array.isArray(v) && key === 'length') continue;
      if (typeof key !== 'string' || ++members > memberCap)
        throw new EnvelopeError('BUDGET_EXCEEDED');
      bytes += textBytes(key);
      if (bytes > textCap) throw new EnvelopeError('BUDGET_EXCEEDED');
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      check();
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        throw new EnvelopeError('INVALID_ENVELOPE');
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
}
/** Freeze parsed own data without retaining another receipt copy. */
export function freezeData<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) freezeData(v);
    Object.freeze(value);
  }
  return value;
}

/** Guarded read facade: Zod copies only data descriptors, with no external getters invoked. */
export function guardedData(value: unknown, check: () => void): unknown {
  const aliases = new WeakMap<object, object>();
  let facades = 0;
  const wrap = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') return input;
    const old = aliases.get(input);
    if (old) return old;
    check();
    if (++facades > 256) throw new EnvelopeError('BUDGET_EXCEEDED');
    const target = Array.isArray(input) ? [] : {};
    const proxy = new Proxy(target, {
      get(_target, key) {
        check();
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        check();
        if (!descriptor) return Reflect.get(target, key);
        if (!('value' in descriptor)) throw new EnvelopeError('INVALID_ENVELOPE');
        return wrap(descriptor.value);
      },
      has(_target, key) {
        check();
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        check();
        return descriptor !== undefined || Reflect.has(target, key);
      },
      ownKeys() {
        check();
        const keys = Reflect.ownKeys(input);
        check();
        return keys;
      },
      getOwnPropertyDescriptor(_target, key) {
        check();
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        check();
        if (!descriptor || !('value' in descriptor)) return undefined;
        if (Array.isArray(input) && key === 'length') return { ...descriptor, writable: true };
        return {
          value: wrap(descriptor.value),
          enumerable: descriptor.enumerable,
          configurable: true,
          writable: true,
        };
      },
    });
    aliases.set(input, proxy);
    return proxy;
  };
  return wrap(value);
}
