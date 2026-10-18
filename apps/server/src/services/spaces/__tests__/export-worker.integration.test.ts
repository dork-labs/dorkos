import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { startExportWorker } from '../exports/worker.js';
import {
  exportCommunity,
  exportMember,
  forever,
  jobRow,
  requestOwnerExport,
  requestPersonalExport,
  runExport,
  seedEntries,
  segmentsOf,
} from './export-jobs-fixture.js';
import { bootstrapHost, startTenancyHarness, type TenancyHarness } from './tenancy-test-harness.js';

let h: TenancyHarness;
let operatorCookie: string;

beforeAll(async () => {
  h = await startTenancyHarness('exportworker');
  operatorCookie = (await bootstrapHost(h, 'Wren Host', 'wren@export-host.test')).cookie;
});

afterAll(async () => {
  await h?.close();
});

const ONE_MESSAGE = 3600;
const long = (n: number) => `message ${n} ${'x'.repeat(3000)}`;

/** Leave no job due for the next test: end every open job in the harness. */
async function settle() {
  await h.pool.query(
    `UPDATE export_archives SET state='cancelled',ended_at=now(),lease_until=NULL
     WHERE state IN ('queued','building')`
  );
}

describe('sharing the export worker', () => {
  // Purpose (review 4): jobs take turns. A long export steps aside after its time slice when
  // another community's job is waiting, and resumes from its last segment later. Fails if the
  // short export waits for the long one to finish, or the long one restarts when it resumes.
  it('lets a small export finish while a long one takes turns', async () => {
    const long1 = await exportCommunity(h, operatorCookie, 'Long Turn Place');
    const short = await exportCommunity(h, operatorCookie, 'Short Turn Place');
    await seedEntries(h, long1, { authorMemberId: long1.owner.memberId, count: 6, textOf: long });
    await seedEntries(h, short, { authorMemberId: short.owner.memberId, count: 1 });
    const bigJob = await requestOwnerExport(h, long1);
    const smallJob = await requestOwnerExport(h, short);
    let firstKey: string | undefined;
    const ran: string[] = [];
    let bigWhenSmallReady: string | undefined;
    for (let round = 0; round < 40; round++) {
      const id = await runExport(h, {
        segmentBytes: ONE_MESSAGE,
        sliceMs: 0,
        hooks: {
          afterSegment: async ({ exportId, segmentNo, kind }) => {
            if (exportId === bigJob.export.id && kind === 'data' && segmentNo === 1)
              firstKey ??= (await segmentsOf(h, exportId))[0].blob_key;
          },
        },
      });
      if (!id) break;
      ran.push(id);
      if (!bigWhenSmallReady && (await jobRow(h, smallJob.export.id)).state === 'ready')
        bigWhenSmallReady = (await jobRow(h, bigJob.export.id)).state;
    }
    expect(bigWhenSmallReady).toBe('building');
    expect(ran[0]).toBe(bigJob.export.id);
    expect(ran[1]).toBe(smallJob.export.id);
    expect(ran.lastIndexOf(smallJob.export.id)).toBeLessThan(ran.lastIndexOf(bigJob.export.id));
    expect(await jobRow(h, bigJob.export.id)).toMatchObject({ state: 'ready' });
    // Resumed, not restarted: the first segment it wrote is still the archive's first.
    expect((await segmentsOf(h, bigJob.export.id))[0].blob_key).toBe(firstKey);
  });

  // Purpose (review 4): one job per community at a time. Fails if a community's second export
  // takes another worker slot while its first is still running.
  it('runs one job per community at a time', async () => {
    const community = await exportCommunity(h, operatorCookie, 'One At A Time Place');
    const bob = await exportMember(h, community, 'Bob One');
    await seedEntries(h, community, { authorMemberId: bob.memberId, count: 2, textOf: long });
    const owner = await requestOwnerExport(h, community);
    const personal = await requestPersonalExport(h, community, bob.cookie);
    let running = false;
    void runExport(h, {
      segmentBytes: ONE_MESSAGE,
      hooks: {
        afterSegment: () => {
          running = true;
          return forever();
        },
      },
    });
    for (let attempt = 0; attempt < 250 && !running; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(running).toBe(true);
    expect(await runExport(h)).toBeNull();
    expect((await jobRow(h, personal.export.id)).state).toBe('queued');
    // Once the first job's lease has lapsed (its worker died), the community's jobs run again.
    const later = new Date(Date.now() + 6 * 60_000);
    expect(await runExport(h, { now: () => later })).not.toBeNull();
    expect([owner.export.id, personal.export.id]).toContain(
      (
        await h.pool.query(
          "SELECT id FROM export_archives WHERE community_id=$1 AND state='ready'",
          [community.communityId]
        )
      ).rows[0]?.id
    );
    await settle();
  });
});

describe('run time and turns', () => {
  // Purpose (review): COMMUNITY_EXPORT_MAX_HOURS counts time spent working, not time spent
  // waiting for a turn. Fails if a job that stepped aside is timed out by the hours it waited.
  it('does not count time spent waiting for a turn toward the deadline', async () => {
    const big = await exportCommunity(h, operatorCookie, 'Patient Place');
    const other = await exportCommunity(h, operatorCookie, 'Waiting Place');
    await seedEntries(h, big, { authorMemberId: big.owner.memberId, count: 3, textOf: long });
    await seedEntries(h, other, { authorMemberId: other.owner.memberId, count: 1 });
    const bigJob = await requestOwnerExport(h, big);
    const otherJob = await requestOwnerExport(h, other);
    const start = Date.now();
    expect(
      await runExport(h, {
        segmentBytes: ONE_MESSAGE,
        sliceMs: 0,
        maxHours: 1,
        now: () => new Date(start),
      })
    ).toBe(bigJob.export.id);
    expect((await jobRow(h, bigJob.export.id)).state).toBe('building');
    await h.pool.query("UPDATE export_archives SET state='cancelled',ended_at=now() WHERE id=$1", [
      otherJob.export.id,
    ]);
    // Three hours later its turn comes round again, with a one-hour limit on work.
    const later = new Date(start + 3 * 3_600_000);
    expect(await runExport(h, { segmentBytes: ONE_MESSAGE, maxHours: 1, now: () => later })).toBe(
      bigJob.export.id
    );
    expect(await jobRow(h, bigJob.export.id)).toMatchObject({ state: 'ready' });
    const run = await h.pool.query<{ run_ms: string }>(
      'SELECT run_ms::text FROM export_archives WHERE id=$1',
      [bigJob.export.id]
    );
    expect(Number(run.rows[0].run_ms)).toBeLessThan(60_000);
  });

  // Purpose (review): a job steps aside only for a waiter that could run. Fails if a job gives
  // up its turn to a community whose own export is already running (nobody could take it).
  it('keeps running when the only waiter cannot be claimed', async () => {
    const busy = await exportCommunity(h, operatorCookie, 'Busy Place');
    const bob = await exportMember(h, busy, 'Bob Busy');
    await seedEntries(h, busy, { authorMemberId: bob.memberId, count: 2, textOf: long });
    await requestOwnerExport(h, busy);
    let running = false;
    void runExport(h, {
      segmentBytes: ONE_MESSAGE,
      hooks: {
        afterSegment: () => {
          running = true;
          return forever();
        },
      },
    });
    for (let attempt = 0; attempt < 250 && !running; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await requestPersonalExport(h, busy, bob.cookie);
    const solo = await exportCommunity(h, operatorCookie, 'Solo Place');
    await seedEntries(h, solo, { authorMemberId: solo.owner.memberId, count: 3, textOf: long });
    const soloJob = await requestOwnerExport(h, solo);
    expect(await runExport(h, { segmentBytes: ONE_MESSAGE, sliceMs: 0 })).toBe(soloJob.export.id);
    expect(await jobRow(h, soloJob.export.id)).toMatchObject({ state: 'ready' });
    await settle();
  });
});

describe('a worker whose database goes away', () => {
  // Purpose (review 5): recording an outcome can fail when the database is gone (at shutdown);
  // the background worker logs it and never leaves a rejected promise unhandled. Fails if a
  // failed-path transaction's error escapes the worker.
  it('logs instead of rejecting when it cannot record a failure', async () => {
    const community = await exportCommunity(h, operatorCookie, 'Gone Place');
    await seedEntries(h, community, { authorMemberId: community.owner.memberId, count: 1 });
    const requested = await requestOwnerExport(h, community);
    // Queries still work (the claim, the lease); new transactions cannot start.
    const broken = new Proxy(h.pool, {
      get(target, property) {
        if (property === 'connect') return () => Promise.reject(new Error('pool is ending'));
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Pool;
    // Two hours of work already done against a one-hour limit: the job fails at its first
    // checkpoint and must record that in a transaction.
    await h.pool.query('UPDATE export_archives SET run_ms=$2 WHERE id=$1', [
      requested.export.id,
      2 * 3_600_000,
    ]);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let recorded: boolean;
    const timer = startExportWorker({
      pool: broken,
      blobStore: h.blobStore,
      settings: { segmentBytes: 256 * 1024 * 1024, ttlHours: 24, maxHours: 1 },
      concurrency: 1,
      pollMs: 10,
    });
    try {
      for (let attempt = 0; attempt < 250; attempt++) {
        if (
          errors.mock.calls.some(
            ([message]) => message === 'Community export state could not be recorded'
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      recorded = errors.mock.calls.some(
        ([message]) => message === 'Community export state could not be recorded'
      );
    } finally {
      clearInterval(timer);
      process.off('unhandledRejection', onUnhandled);
      errors.mockRestore();
    }
    expect(recorded).toBe(true);
    expect(unhandled).toEqual([]);
    // The job keeps its claim until the lease lapses; nothing was recorded.
    expect((await jobRow(h, requested.export.id)).state).toBe('building');
    await settle();
  });
});
