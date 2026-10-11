import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../data.js';
import { readStreamAccessBatched } from '../routes/community/stream-access-batch.js';

/** A pool that answers every batched query with one row per request whose id is not 'gone'. */
function fakePool() {
  const calls: Array<{ sql: string; values: string[][] }> = [];
  const pool = {
    async query(sql: string, values: string[][]) {
      calls.push({ sql, values });
      const rows = values[0]
        .map((id, index) => ({ id, i: String(index + 1) }))
        .filter((row) => row.id !== 'gone')
        .map((row) => ({
          i: row.i,
          active: true,
          joined: true,
          archived: false,
          epoch: Number(row.id.replace(/\D/g, '')) || 0,
          lifecycle: 'active',
          taken_down: false,
          expires_at: null,
        }));
      return { rows };
    },
  };
  return { pool: pool as unknown as Pool, calls };
}

function agent(id: string): Principal {
  return {
    id,
    kind: 'agent',
    community_id: 'c',
    ownerMemberId: 'owner',
    credentialHash: `hash-${id}`,
    credentialKind: 'agent',
  } as unknown as Principal;
}

describe('readStreamAccessBatched', () => {
  it('checks every stream that asks in the same moment in one query, each its own answer', async () => {
    // Purpose: fails if each stream's recheck is its own query: at 10,000 streams that was 600
    // queries a second, and posts waited behind them.
    const { pool, calls } = fakePool();
    const answers = await Promise.all(
      ['a1', 'gone', 'a3'].map((id) => readStreamAccessBatched(pool, agent(id), null, 'ch'))
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].values[0]).toEqual(['a1', 'gone', 'a3']);
    expect(answers.map((answer) => answer?.epoch)).toEqual([1, undefined, 3]);
  });

  it('fails every check in a batch whose query fails', async () => {
    const pool = {
      query: async () => {
        throw new Error('database down');
      },
    } as unknown as Pool;
    await expect(readStreamAccessBatched(pool, agent('a1'), null, 'ch')).rejects.toThrow(
      'database down'
    );
  });
});
