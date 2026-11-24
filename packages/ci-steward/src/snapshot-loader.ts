/**
 * A snapshot loader for a reader that asks for overlapping spans of days (the
 * daily report's sparklines and its merge-to-release panel).
 */
import { readData, snapshotPath, SnapshotSchema, type Snapshot } from './data.ts';

/**
 * A snapshot loader that reads each day at most once.
 *
 * @param dataDir - A working tree of the data branch.
 */
export function snapshotLoader(dataDir: string): (days: readonly string[]) => Snapshot[] {
  const cache = new Map<string, Snapshot | null>();
  return (days) =>
    days.flatMap((d) => {
      if (!cache.has(d)) cache.set(d, readData(dataDir, snapshotPath(d), SnapshotSchema));
      const s = cache.get(d)!;
      return s ? [s] : [];
    });
}
