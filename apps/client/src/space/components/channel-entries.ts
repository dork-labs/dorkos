import type { Entry } from '../types.js';

/** Merge `incoming` into `previous` by id, in sequence order. */
export function mergeEntries(previous: Entry[], incoming: Entry[]) {
  const byId = new Map(previous.map((entry) => [entry.id, entry]));
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}
/** Replace the entries already shown with their changed versions; never add one. */
export function replaceEntries(previous: Entry[], changed: ReadonlyMap<string, Entry>) {
  return previous.some((entry) => changed.has(entry.id))
    ? previous.map((entry) => changed.get(entry.id) ?? entry)
    : previous;
}
