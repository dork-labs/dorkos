import { expect, it } from 'vitest';
import { SqliteModelStore } from '../store.js';
it('reads scope tails and preserves unknown cumulative costs', () => {
  const store = new SqliteModelStore(':memory:');
  try {
    store.createSession('tails');
    expect(store.latestUsage('tails')).toBeUndefined();
    expect(store.costTotal('tails')).toBeUndefined();
    store.recordUsage('tails', { requestId: 'a', inputTokens: 10, costUsd: 0.2 });
    store.recordUsage('tails', { requestId: 'b', inputTokens: 20, costUsd: 0.3 });
    store.recordUsage('tails', { requestId: 'child', inputTokens: 900, costUsd: 0.1 }, 'child:one');
    expect(store.latestUsage('tails')?.inputTokens).toBe(20);
    expect(store.costTotal('tails')).toBeCloseTo(0.6);
    store.recordUsage('tails', { requestId: 'unknown' }, 'beat:unknown');
    expect(store.costTotal('tails')).toBeUndefined();
    store.appendMessage('tails', { role: 'user', content: 'First' });
    store.appendMessage('tails', { role: 'user', content: 'Second' });
    const checkpoint = store.checkpoint('tails', {
      summary: { role: 'user', content: 'Summary' },
      firstRetainedSeq: 2,
      before: { tokens: 20, source: 'provider' },
      after: { tokens: 4, source: 'estimated' },
      usage: { requestId: 'summary' },
    });
    expect(store.latestCheckpoint('tails')).toEqual(checkpoint);
  } finally {
    store.close();
  }
});
