import { readDurations } from './balance.ts';

// Every runner uses the same tested commit time. Hash the resulting mode, not
// that per-commit timestamp: unchanged test partitions may still use the cache.
const durations = readDurations(
  new URL('./durations.json', import.meta.url),
  Number(process.argv[2]) * 1000
);
console.log(`VITEST_SHARD_MODE=${durations ? 'duration' : 'default'}`);
