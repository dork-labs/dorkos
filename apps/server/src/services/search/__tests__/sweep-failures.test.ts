import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { messages, eq, type Db } from '@dorkos/db';
import { logger } from '../../../lib/logger.js';
import { SearchIndexer } from '../indexer.js';
import { DISCOVERY_FAILURE_KEY } from '../frontier-store.js';
import { sweepRowSource } from '../row-frontier.js';
import type { RowContainer, RowSource } from '../types.js';

/**
 * The two ways a sweep used to stop filling the index without saying why
 * (DOR-709).
 *
 * Both are one level below the per-container `try` every mechanism already has.
 * Discovery — the call that produces the container list — sat OUTSIDE it, so a
 * source whose list would not read took its whole sweep down and left nothing in
 * `search_sources.last_error` to explain the silence. And the write that RECORDS
 * a container failure sat inside the catch with nothing around it, so a busy
 * database turned one container's bad day into an escape from the catch, the
 * loop, and the sweep.
 */

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

/** A row source with a fixed container list and a body per container. */
function rowSource(id: string, containers: readonly string[]): RowSource {
  return {
    id,
    mechanism: 'rows',
    corpus: 'dorkos',
    listContainers: () =>
      containers.map((originKey) => ({ originKey, containerPath: null, maxOrdinal: 1 })),
    readSince: (_db, originKey) => ({
      skipped: 0,
      messages: [
        {
          originKey,
          ordinal: 1,
          messageId: null,
          role: 'user' as const,
          createdAt: null,
          body: `something said in ${originKey}`,
        },
      ],
    }),
  };
}

/** How many message rows one source has in the index. */
function indexedCount(sourceId: string): number {
  return db.select().from(messages).where(eq(messages.sourceId, sourceId)).all().length;
}

describe('a source whose container list will not read', () => {
  it('records the failure against the mechanism that owns discovery, not the backstop', async () => {
    // The indexer's per-source wrap is a backstop for whatever no mechanism
    // catches. Discovery is not that: the mechanism knows which source it was
    // listing and can still prune nothing, stamp the containers that exist, and
    // hand back a sweep. `SOURCE_FAILURE_KEY` appearing here means the throw got
    // all the way up, which is the state this ticket removes.
    const exploding: RowSource = {
      ...rowSource('exploding', []),
      listContainers: () => {
        throw new Error('the container list would not read');
      },
    };

    const result = await new SearchIndexer(db, [exploding]).sweep();

    expect(result.failures).toEqual([
      {
        sourceId: 'exploding',
        originKey: DISCOVERY_FAILURE_KEY,
        message: 'the container list would not read',
      },
    ]);
  });
});

describe('a database that will not take the write recording a failure', () => {
  /**
   * A database whose NEXT transaction throws `SQLITE_BUSY`, once.
   *
   * `busy_timeout` is five seconds and this process runs four reconcilers, so a
   * write that loses that race is a real outcome rather than a contrived one.
   * Arming exactly one transaction is what lets the test show that the sweep
   * carries on: the container after the failing one still indexes through the
   * same handle.
   */
  function busyOnce(real: Db): Db {
    let armed = true;
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'transaction' && armed) {
          armed = false;
          return () => {
            throw new Error('SQLITE_BUSY: database is locked');
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as Db;
  }

  it('keeps sweeping the containers after the one whose failure could not be recorded', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const containers: RowContainer[] = [
      { originKey: 'container-bad', containerPath: null, maxOrdinal: 1 },
      { originKey: 'container-good', containerPath: null, maxOrdinal: 1 },
    ];
    const source: RowSource = {
      id: 'partly-broken',
      mechanism: 'rows',
      corpus: 'dorkos',
      listContainers: () => containers,
      readSince: (_db, originKey) => {
        if (originKey === 'container-bad') throw new Error('unexpected record shape at line 12');
        return {
          skipped: 0,
          messages: [
            {
              originKey,
              ordinal: 1,
              messageId: null,
              role: 'user' as const,
              createdAt: null,
              body: 'indexed anyway',
            },
          ],
        };
      },
    };

    const sweep = await sweepRowSource(busyOnce(db), source, '2026-08-26T10:00:00.000Z');

    // The container's OWN failure survives — before this, the busy write escaped
    // the catch and the sweep reported one anonymous source-level error instead.
    expect(sweep.failures).toEqual([
      {
        sourceId: 'partly-broken',
        originKey: 'container-bad',
        message: 'unexpected record shape at line 12',
      },
    ]);
    expect(sweep.indexed).toBe(1);
    expect(indexedCount('partly-broken')).toBe(1);
    // Degraded to a log line rather than silently swallowed: the reason the row
    // says nothing is itself worth knowing.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[Search]'),
      expect.objectContaining({ error: expect.stringContaining('SQLITE_BUSY') as unknown })
    );
    warn.mockRestore();
  });
});
