/**
 * What may ride a `ctx` message across the boundary (DOR-2686, spec §5.2):
 * plain data only.
 *
 * Node's advanced serialization already refuses functions and symbols, but it
 * carries more than the ctx needs (Maps, Sets, Errors, RegExps, objects with a
 * `__proto__` own key), and the host passes a call's arguments straight to
 * the extension's real ctx. So every argument the host receives, every event
 * and value it sends, and every answer a reverse call returns is checked here
 * first. Anything else is refused with a plain error, never acted on.
 *
 * Allowed: `null`, `undefined`, booleans, finite and non-finite numbers,
 * strings, arrays, plain objects (prototype `Object.prototype` or `null`),
 * `Date` and `Uint8Array`. Refused: everything else, any own key named
 * `__proto__` (an `Object.assign` or a `for…in` copy downstream would turn it
 * into a prototype change), nesting deeper than {@link MAX_WIRE_DEPTH}, more
 * than {@link MAX_WIRE_NODES} parts, cycles, arrays with holes, and anything
 * whose expanded size passes {@link MAX_WIRE_EXPANDED_BYTES}.
 *
 * Pure and free of server imports, so the child can share it.
 *
 * @module services/extensions/isolation/ctx-wire
 */

import { ISOLATION_LIMITS } from './ipc-protocol.js';

/** Deepest nesting a ctx value may have. */
export const MAX_WIRE_DEPTH = 32;

/** Most parts (values and keys) a ctx value may have. */
export const MAX_WIRE_NODES = 50_000;

/**
 * The most a value may hold once expanded, in the same upper-estimate bytes
 * `message-size.ts` counts: the channel's own message cap. Counted on EVERY
 * visit, so a shared object referenced many times counts every time, as it
 * would when the host serialises it (`JSON.stringify` in `storage.saveData`
 * writes each reference out in full).
 */
export const MAX_WIRE_EXPANDED_BYTES = ISOLATION_LIMITS.maxMessageBytes;

/** The one own key refused anywhere in a value. */
const PROTO_KEY = '__proto__';

/** Options for {@link wireDataProblem}. */
export interface WireDataOptions {
  /**
   * The expanded-size budget, in bytes. Defaults to
   * {@link MAX_WIRE_EXPANDED_BYTES}; the host passes `Infinity` only for
   * values its own real ctx produced (a call's answer), never for anything
   * the child sent.
   */
  maxBytes?: number;
  /** The parts budget; defaults to {@link MAX_WIRE_NODES}. Same rule as `maxBytes`. */
  maxNodes?: number;
}

/**
 * Why a value may not cross as ctx data, or `null` when it may.
 *
 * Two shapes a structured clone keeps small but that expand when the host
 * uses them are refused: an array with holes or a length past
 * {@link MAX_WIRE_NODES} (`a = []; a.length = 9e7` is a few bytes on the
 * channel and 90 million `null`s in `JSON.stringify`), and a shared object
 * referenced so often that its expanded size passes the budget (one 1.5 MB
 * string referenced 16,000 times).
 *
 * @param value - An argument list, an event payload or an answer.
 * @param options - See {@link WireDataOptions}.
 * @returns A short reason (for the log and the refusal), or `null`.
 */
export function wireDataProblem(value: unknown, options: WireDataOptions = {}): string | null {
  const maxBytes = options.maxBytes ?? MAX_WIRE_EXPANDED_BYTES;
  const maxNodes = options.maxNodes ?? MAX_WIRE_NODES;
  let nodes = 0;
  let bytes = 0;
  const onPath = new Set<object>();
  const tooLarge = 'it is too large';

  const visit = (v: unknown, depth: number): string | null => {
    if (++nodes > maxNodes) return tooLarge;
    if (depth > MAX_WIRE_DEPTH) return 'it is nested too deeply';
    switch (typeof v) {
      case 'undefined':
      case 'boolean':
      case 'number':
        bytes += 16;
        return bytes > maxBytes ? tooLarge : null;
      case 'string':
        bytes += 8 + v.length * 2;
        return bytes > maxBytes ? tooLarge : null;
      case 'object':
        break;
      default:
        return `it holds a ${typeof v}`;
    }
    if (v === null) {
      bytes += 8;
      return bytes > maxBytes ? tooLarge : null;
    }
    if (v instanceof Date || v instanceof Uint8Array) {
      bytes += 16 + (v instanceof Uint8Array ? v.byteLength : 0);
      return bytes > maxBytes ? tooLarge : null;
    }
    const proto = Object.getPrototypeOf(v);
    const isArray = Array.isArray(v);
    if (!isArray && proto !== Object.prototype && proto !== null) {
      return 'it holds something other than plain data';
    }
    if (isArray) {
      if (proto !== Array.prototype) return 'it holds something other than plain data';
      if (v.length > maxNodes) return tooLarge;
      // Holes (or extra named keys) make the own keys disagree with length.
      if (Object.keys(v).length !== v.length) return 'it holds an array with holes';
    }
    if (onPath.has(v)) return 'it refers to itself';
    bytes += 16;
    if (bytes > maxBytes) return tooLarge;
    onPath.add(v);
    try {
      for (const key of Reflect.ownKeys(v)) {
        if (typeof key === 'symbol') return 'it holds a symbol key';
        if (key === PROTO_KEY) return 'it holds a "__proto__" key';
        if (isArray && key === 'length') continue;
        if (!isArray) {
          bytes += 8 + key.length * 2;
          if (bytes > maxBytes) return tooLarge;
        }
        const desc = Object.getOwnPropertyDescriptor(v, key);
        if (!desc) continue;
        if (desc.get || desc.set) return 'it holds an accessor';
        const problem = visit(desc.value, depth + 1);
        if (problem) return problem;
      }
    } finally {
      onPath.delete(v);
    }
    return null;
  };

  return visit(value, 0);
}
