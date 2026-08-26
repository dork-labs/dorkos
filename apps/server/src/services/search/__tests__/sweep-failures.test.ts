import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { messages, searchSources, eq, type Db } from '@dorkos/db';
import { logger } from '../../../lib/logger.js';
import { SearchIndexer } from '../indexer.js';
import { DISCOVERY_FAILURE_KEY, SOURCE_ERROR_MARK } from '../frontier-store.js';
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
    listContainers: () =>
      containers.map((originKey) => ({ originKey, containerPath: null, maxOrdinal: 1 })),
    readSince: (_db, originKey) => ({
      skipped: 0,
      messages: [
        {
          originKey,
          ordinal: 1,
          role: 'user' as const,
          createdAt: null,
          body: `something said in ${originKey}`,
        },
      ],
    }),
  };
}

/** Every frontier row of one source, keyed by container. */
function frontierOf(sourceId: string) {
  return db.select().from(searchSources).where(eq(searchSources.sourceId, sourceId)).all();
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

  it('leaves what it already indexed alone and says why on the rows themselves', async () => {
    // `searchForCaller` builds its warnings from `search_sources.last_error`, so
    // a failure recorded only on the sweep result is one only the server log
    // knows about. Somebody searching has to be told that a source went dark.
    let listable = true;
    const flaky: RowSource = {
      ...rowSource('flaky', ['container-a', 'container-b']),
      listContainers: () => {
        if (!listable) throw new Error('the store moved out from under us');
        return ['container-a', 'container-b'].map((originKey) => ({
          originKey,
          containerPath: null,
          maxOrdinal: 1,
        }));
      },
    };
    const indexer = new SearchIndexer(db, [flaky]);
    await indexer.sweep();
    expect(indexedCount('flaky')).toBe(2);

    listable = false;
    const dark = await indexer.sweep();

    expect(dark.failures).toEqual([
      {
        sourceId: 'flaky',
        originKey: DISCOVERY_FAILURE_KEY,
        message: 'the store moved out from under us',
      },
    ]);
    // An empty container list from a failed discovery is never "every container
    // is gone".
    expect(dark.pruned).toBe(0);
    expect(indexedCount('flaky')).toBe(2);
    expect(frontierOf('flaky').map((row) => row.lastError)).toEqual([
      `${SOURCE_ERROR_MARK}the store moved out from under us`,
      `${SOURCE_ERROR_MARK}the store moved out from under us`,
    ]);
    // No row is invented for the discovery that failed: `search_sources` is
    // keyed by container, and a row the reader can never return would be pruned
    // on the first healthy sweep.
    expect(frontierOf('flaky')).toHaveLength(2);

    listable = true;
    await indexer.sweep();
    expect(frontierOf('flaky').map((row) => row.lastError)).toEqual([null, null]);
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
      listContainers: () => containers,
      readSince: (_db, originKey) => {
        if (originKey === 'container-bad') throw new Error('unexpected record shape at line 12');
        return {
          skipped: 0,
          messages: [
            {
              originKey,
              ordinal: 1,
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

  it('still prunes what vanished and still stamps the attempt', async () => {
    // The write that failed was bookkeeping about ONE container. Everything the
    // sweep does for the source as a whole has to happen anyway, or a busy
    // moment freezes the index's own housekeeping too.
    await sweepRowSource(db, rowSource('partly-broken', ['gone', 'stays']), '2026-08-26T10:00:00Z');
    expect(indexedCount('partly-broken')).toBe(2);

    const breaking: RowSource = {
      id: 'partly-broken',
      mechanism: 'rows',
      // Higher than the watermark the first sweep left, so the container is
      // genuinely re-read rather than skipped as unchanged.
      listContainers: () => [{ originKey: 'stays', containerPath: null, maxOrdinal: 2 }],
      readSince: () => {
        throw new Error('unreadable');
      },
    };
    const sweep = await sweepRowSource(busyOnce(db), breaking, '2026-08-26T10:05:00Z');

    expect(sweep.pruned).toBe(1);
    expect(
      db
        .select()
        .from(searchSources)
        .where(eq(searchSources.sourceId, 'partly-broken'))
        .all()
        .map((row) => [row.originKey, row.lastIndexedAt])
    ).toEqual([['stays', '2026-08-26T10:05:00Z']]);
  });

  it('does not clear the error of a container whose failure it could not write', async () => {
    // The sweep retires this source's whole-source stamp at the end of a healthy
    // pass, and `stays` failed in that very pass. An earlier version cleared
    // unconditionally and argued the container would re-stamp itself — but the
    // re-stamp is best effort, so a busy database left a broken container
    // reading `last_error = NULL` until the next tick, five minutes later, which
    // is exactly the silence this ticket exists to remove.
    await sweepRowSource(db, rowSource('partly-broken', ['stays']), '2026-08-26T10:00:00Z');
    // A stamp from an earlier dark spell, which is what the clear is FOR — so
    // this cannot pass merely because the clear was too timid to fire.
    db.update(searchSources)
      .set({ lastError: `${SOURCE_ERROR_MARK}the source went dark earlier` })
      .where(eq(searchSources.sourceId, 'partly-broken'))
      .run();

    const breaking: RowSource = {
      id: 'partly-broken',
      mechanism: 'rows',
      listContainers: () => [{ originKey: 'stays', containerPath: null, maxOrdinal: 2 }],
      readSince: () => {
        throw new Error('unreadable');
      },
    };
    await sweepRowSource(busyOnce(db), breaking, '2026-08-26T10:05:00Z');

    expect(
      db
        .select()
        .from(searchSources)
        .where(eq(searchSources.sourceId, 'partly-broken'))
        .all()
        .map((row) => row.lastError)
    ).toEqual([`${SOURCE_ERROR_MARK}the source went dark earlier`]);
  });

  it('leaves a container error that merely LOOKS like a whole-source stamp', async () => {
    // A bracketed prefix on an error message is an existing idiom in this repo
    // (`[q3] …`), so a mark of plain `[source] ` would eventually arrive as some
    // projection's own message and be cleared as if the sweep had written it —
    // silencing the one container that had something to say. The mark leads with
    // a NUL, which no real message can contain.
    await sweepRowSource(db, rowSource('impostor', ['a']), '2026-08-26T10:00:00Z');
    db.update(searchSources)
      .set({ lastError: '[source] a projection that formats its errors this way' })
      .where(eq(searchSources.sourceId, 'impostor'))
      .run();

    await sweepRowSource(db, rowSource('impostor', ['a']), '2026-08-26T10:05:00Z');

    expect(frontierOf('impostor').map((row) => row.lastError)).toEqual([
      '[source] a projection that formats its errors this way',
    ]);
  });

  it('clears the error of a container that recovered in the same pass', async () => {
    // The paired positive control. Sparing failures is worthless if it spares
    // everything: a warning nothing clears outlives its fault forever, and an
    // unchanged container writes no row of its own to clear it.
    await sweepRowSource(db, rowSource('recovers', ['a', 'b']), '2026-08-26T10:00:00Z');
    db.update(searchSources)
      .set({ lastError: `${SOURCE_ERROR_MARK}the source went dark earlier` })
      .where(eq(searchSources.sourceId, 'recovers'))
      .run();

    await sweepRowSource(db, rowSource('recovers', ['a', 'b']), '2026-08-26T10:05:00Z');

    expect(frontierOf('recovers').map((row) => row.lastError)).toEqual([null, null]);
  });
});
