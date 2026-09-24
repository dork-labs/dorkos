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
    const start = Date.now();
    let calls = 0;
    // The claim sees the start; everything after it sees a time past the one-hour deadline, so
    // the job fails at its first checkpoint and must record that in a transaction.
    const now = () => new Date(calls++ === 0 ? start : start + 3 * 3600_000);
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
      now,
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
