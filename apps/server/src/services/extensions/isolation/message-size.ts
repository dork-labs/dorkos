/**
 * Bound the size of a message from an isolated child without copying it
 * (DOR-2686, spec §9).
 *
 * Node has already deserialized the message by the time the host sees it
 * (the channel has no limit of its own, a known gap recorded in the spec), so
 * measuring it must not cost a second copy: re-serializing a huge payload
 * just to learn it is huge would double the very spike the 4 MB cap bounds.
 * This walks the value instead, adding up an upper estimate of what it holds,
 * and stops the moment the running total passes the cap.
 *
 * It fails closed: a value with more than {@link MAX_NODES} parts, nested
 * deeper than {@link MAX_DEPTH}, or of a kind it does not recognise measures
 * as over the cap, so such a message is dropped even when it is small. A
 * message the child built that way is malformed for this protocol anyway.
 *
 * @module services/extensions/isolation/message-size
 */

/** Most parts (values, keys) walked before a message counts as too large. */
export const MAX_NODES = 100_000;

/** Deepest nesting walked before a message counts as too large. */
export const MAX_DEPTH = 64;

/**
 * An upper estimate of a message's size in bytes, or a number over `cap` as
 * soon as it is known to exceed it (or cannot be bounded).
 *
 * @param value - A deserialized message.
 * @param cap - The limit, in bytes.
 * @returns The estimate, never more than a little over `cap`.
 */
export function boundedMessageSize(value: unknown, cap: number): number {
  const over = cap + 1;
  let total = 0;
  let nodes = 0;
  const seen = new Set<object>();
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const { value: v, depth } = stack.pop()!;
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return over;
    switch (typeof v) {
      case 'string':
        // UTF-16 at worst; a one-byte string is counted generously.
        total += 8 + v.length * 2;
        break;
      case 'number':
      case 'boolean':
      case 'undefined':
      case 'bigint':
        total += 16;
        break;
      case 'object': {
        if (v === null) {
          total += 8;
          break;
        }
        if (seen.has(v)) break;
        seen.add(v);
        if (ArrayBuffer.isView(v)) {
          total += 16 + v.byteLength;
          break;
        }
        if (v instanceof ArrayBuffer || v instanceof SharedArrayBuffer) {
          total += 16 + v.byteLength;
          break;
        }
        total += 16;
        if (v instanceof Date || v instanceof RegExp) break;
        if (v instanceof Map) {
          for (const [k, item] of v) {
            stack.push({ value: k, depth: depth + 1 }, { value: item, depth: depth + 1 });
          }
          break;
        }
        if (v instanceof Set) {
          for (const item of v) stack.push({ value: item, depth: depth + 1 });
          break;
        }
        for (const key of Object.keys(v)) {
          total += 8 + key.length * 2;
          stack.push({ value: (v as Record<string, unknown>)[key], depth: depth + 1 });
        }
        break;
      }
      default:
        // Functions and symbols never survive the channel; refuse anything else.
        return over;
    }
    if (total > cap) return over;
  }
  return total;
}
