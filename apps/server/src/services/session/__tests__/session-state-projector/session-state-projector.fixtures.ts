/** Clock budgets and a stream reader shared by the session-state projector tests. */

export const TIMEOUT_MS = 10 * 60 * 1000;
export const PARK_CEILING_MS = 4 * 60 * 60 * 1000;

/** Drain up to `count` events from an async iterable, then return them. */
export async function take(iter: AsyncIterable<unknown>, count: number): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const e of iter) {
    out.push(e);
    if (out.length >= count) break;
  }
  return out;
}
