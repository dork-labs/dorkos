import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Read a reviewed snapshot, refusing unusable or over-30-day-old measurements. */
export function readDurations(file: string | URL, asOf: number): Record<string, number> | null {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const age = asOf - Date.parse(data.measuredAt);
    if (data.version !== 1 || !Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) return null;
    if (!data.durations || Array.isArray(data.durations) || typeof data.durations !== 'object')
      return null;
    const entries = Object.entries(data.durations);
    if (
      !entries.length ||
      entries.some(
        ([file, ms]) =>
          !/^(apps|packages)\//.test(file) ||
          typeof ms !== 'number' ||
          !Number.isFinite(ms) ||
          ms <= 0
      )
    )
      return null;
    return data.durations;
  } catch {
    return null;
  }
}

/** Deterministic longest-first placement; every collected item goes in exactly one bin. */
export function balance<T extends { key: string }>(
  items: T[],
  count: number,
  durations: Record<string, number>
) {
  const knownValues = items
    .map(({ key }) => durations[key])
    .filter((ms) => (ms ?? 0) > 0) as number[];
  const known = knownValues.sort((a, b) => a - b);
  // An unknown file is work, never a zero-cost item. Use this package's median,
  // with a one-second floor (also the estimate for an entirely new package).
  const estimate = Math.max(1000, known[Math.floor(known.length / 2)] ?? 1000);
  const bins = Array.from({ length: count }, () => ({ items: [] as T[], ms: 0 }));
  // Each turbo package is a separate Vitest run. Rotate tie priority by package
  // so the extra work in small packages doesn't always land on runner one.
  const pkg = items[0]?.key.split('/').slice(0, 2).join('/') ?? '';
  const offset = createHash('sha1').update(pkg).digest().readUInt32LE(0) % count;
  const priority = [...bins.slice(offset), ...bins.slice(0, offset)];
  const ranked = items
    .map((item) => ({ item, ms: durations[item.key] ?? estimate }))
    .sort(
      (a, b) => b.ms - a.ms || (a.item.key < b.item.key ? -1 : a.item.key > b.item.key ? 1 : 0)
    );
  for (const { item, ms } of ranked) {
    const bin = priority.reduce((best, next) => (next.ms < best.ms ? next : best));
    bin.items.push(item);
    bin.ms += ms;
  }
  return bins;
}
