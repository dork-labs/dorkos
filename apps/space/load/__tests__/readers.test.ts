import { describe, expect, it } from 'vitest';
import { startReaders } from '../readers.js';

// Purpose: every real run reads its streams on worker threads. This fails if a thread cannot
// load its TypeScript entry, if a share never says it has settled, or if stopping loses a
// stream's outcome or leaves a thread running. Port 1 refuses every connection, so no server
// is needed: each stream fails to open at once.
describe('startReaders on worker threads', () => {
  it('settles, stops and hands back one outcome per stream', async () => {
    const readers = startReaders({
      baseUrl: 'http://127.0.0.1:1',
      communityId: 'c',
      channelId: 'ch',
      tokens: ['a', 'b', 'c'],
      runId: 'test',
      postCapacity: 1,
      threads: 2,
    });
    expect(await readers.settled).toEqual({ opened: 0, failed: 3 });
    readers.startPosting();
    const results = await readers.stop();
    expect(results.outcomes).toHaveLength(3);
    expect(results.outcomes.every((outcome) => !outcome.opened && !outcome.endedEarly)).toBe(true);
    expect(results.deliveries.count).toBe(0);
  }, 20_000);
});
