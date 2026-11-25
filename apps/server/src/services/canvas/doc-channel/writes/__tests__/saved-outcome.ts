/**
 * Test helper for the document file save tests: the answer of a save that is
 * expected to land, with the `stale` outcome (the file changed underneath)
 * turned into a thrown error so the test reads `body` directly.
 *
 * @module services/canvas/doc-channel/writes/__tests__/saved-outcome
 */

/**
 * A save's answer when the file did not change underneath it.
 *
 * @param result - What the save returned.
 * @returns The same answer, narrowed to the saved outcome.
 * @throws When the save met changed bytes instead.
 */
export function saved<T>(result: T): Exclude<T, { stale: unknown }> {
  if (typeof result === 'object' && result !== null && 'stale' in result)
    throw new Error('The file changed underneath this save');
  return result as Exclude<T, { stale: unknown }>;
}
