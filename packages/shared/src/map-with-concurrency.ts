/**
 * An ordered promise pool: map a list through an async function with a fixed
 * number of calls in flight.
 *
 * Shared by the machine-wide session fan-out and the marketplace update check,
 * which both have to touch one slow thing (a runtime's session store, a git
 * remote) per item without opening all of them at once.
 *
 * @module shared/map-with-concurrency
 */

/**
 * Map `items` through `fn` with at most `concurrency` calls in flight,
 * returning results in INPUT order whatever order they finish in. A
 * `concurrency` below 1 is treated as 1. A rejection from `fn` rejects the
 * whole map, as `Promise.all` does; callers that need per-item isolation catch
 * inside `fn`.
 *
 * @param items - The inputs, visited in order.
 * @param concurrency - The most calls allowed in flight at once.
 * @param fn - The async mapping.
 * @returns One result per input, at the input's index.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  }
  const width = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
