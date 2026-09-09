/** @vitest-environment node */
import { describe, expect, it } from 'vitest';

import type { ManagedConnectorDatabase } from '../authority-service';
import { lockManagedEventCapacity } from '../event-capacity-service';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('managed event capacity locking', () => {
  it('serializes a deterministic two-transaction admission interleaving', async () => {
    const firstRead = deferred();
    const secondObserved = deferred<'blocked' | 'unlocked'>();
    const releaseFirst = deferred();
    const waiters: Array<() => void> = [];
    let rows = 0;
    let owner: number | null = null;
    let transactionId = 0;

    const db = {
      transaction: async <T>(operation: (tx: unknown) => Promise<T>): Promise<T> => {
        const id = ++transactionId;
        let requestedLock = false;
        const builder = {
          from() {
            return this;
          },
          where() {
            return this;
          },
          for(mode: string) {
            requestedLock = mode === 'update';
            return this;
          },
          then(
            resolve: (value: Array<{ retainedRows: number }>) => void,
            reject: (error: unknown) => void
          ) {
            void (async () => {
              if (requestedLock) {
                if (owner !== null && owner !== id) {
                  secondObserved.resolve('blocked');
                  await new Promise<void>((next) => waiters.push(next));
                }
                owner = id;
              } else if (id === 2) {
                secondObserved.resolve('unlocked');
              }
              const snapshot = rows;
              if (id === 1) firstRead.resolve();
              resolve([{ retainedRows: snapshot }]);
            })().catch(reject);
          },
        };
        const tx = {
          id,
          execute: async () => ({ rows: [] }),
          select: () => builder,
        };
        try {
          return await operation(tx);
        } finally {
          if (owner === id) {
            owner = null;
            waiters.shift()?.();
          }
        }
      },
    } as unknown as ManagedConnectorDatabase;

    async function admit(): Promise<'accepted' | 'limited'> {
      return db.transaction(async (tx) => {
        const capacity = await lockManagedEventCapacity(tx, '11111111-1111-4111-8111-111111111111');
        if (capacity.retainedRows + 1 > 1) return 'limited';
        if ((tx as unknown as { id: number }).id === 1) await releaseFirst.promise;
        rows = capacity.retainedRows + 1;
        return 'accepted';
      });
    }

    const first = admit();
    await firstRead.promise;
    const second = admit();
    const observed = await secondObserved.promise;
    releaseFirst.resolve();
    expect(observed).toBe('blocked');
    await expect(Promise.all([first, second])).resolves.toEqual(['accepted', 'limited']);
    expect(rows).toBe(1);
  });
});
