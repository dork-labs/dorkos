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
 * than {@link MAX_WIRE_NODES} parts, and cycles.
 *
 * Pure and free of server imports, so the child can share it.
 *
 * @module services/extensions/isolation/ctx-wire
 */

/** Deepest nesting a ctx value may have. */
export const MAX_WIRE_DEPTH = 32;

/** Most parts (values and keys) a ctx value may have. */
export const MAX_WIRE_NODES = 50_000;

/** The one own key refused anywhere in a value. */
const PROTO_KEY = '__proto__';

/**
 * Why a value may not cross as ctx data, or `null` when it may.
 *
 * @param value - An argument list, an event payload or an answer.
 * @returns A short reason (for the log and the refusal), or `null`.
 */
export function wireDataProblem(value: unknown): string | null {
  let nodes = 0;
  const onPath = new Set<object>();

  const visit = (v: unknown, depth: number): string | null => {
    if (++nodes > MAX_WIRE_NODES) return 'it is too large';
    if (depth > MAX_WIRE_DEPTH) return 'it is nested too deeply';
    switch (typeof v) {
      case 'undefined':
      case 'boolean':
      case 'number':
      case 'string':
        return null;
      case 'object':
        break;
      default:
        return `it holds a ${typeof v}`;
    }
    if (v === null) return null;
    if (v instanceof Date || v instanceof Uint8Array) return null;
    const proto = Object.getPrototypeOf(v);
    const isArray = Array.isArray(v);
    if (!isArray && proto !== Object.prototype && proto !== null) {
      return 'it holds something other than plain data';
    }
    if (isArray && proto !== Array.prototype) return 'it holds something other than plain data';
    if (onPath.has(v)) return 'it refers to itself';
    onPath.add(v);
    try {
      for (const key of Reflect.ownKeys(v)) {
        if (typeof key === 'symbol') return 'it holds a symbol key';
        if (key === PROTO_KEY) return 'it holds a "__proto__" key';
        if (isArray && key === 'length') continue;
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
