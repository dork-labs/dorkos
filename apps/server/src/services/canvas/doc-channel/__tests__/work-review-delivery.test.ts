/**
 * A person's review of expired and in-doubt document work, over real SQLite,
 * the real pump and real boot recovery (spec `doc-channel` task 2.5).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sql,
  eq,
  canvasDocBatches,
  canvasDocDeliveries,
  sessionMessageAcceptanceReceipts,
  type Db,
} from '@dorkos/db';
import { batchFixture, NOW, type BatchFixture } from './batch-fixtures.js';
import { DocBatchDeliveryPump, type DocBatchPumpOptions } from '../delivery/pump.js';
import { clearDocBatch, replayDocBatch, type DocReplayInput } from '../delivery/replay.js';
import { DocChannelMetrics } from '../../../observability/doc-channel-metrics.js';

const databases: Db[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.$client.close();
});

const DAY = 24 * 3600_000;

/** A pump on its own clock; the grant service keeps the fixture's fixed `NOW`. */
function pumpFor(f: BatchFixture, clock: { time: number }) {
  f.db.$client.exec(
    'CREATE TABLE IF NOT EXISTS fixture_doc_warning (batch_id TEXT, generation TEXT, warned_at TEXT, PRIMARY KEY(batch_id,generation))'
  );
  const options: DocBatchPumpOptions = {
    db: f.db,
    store: f.store,
    grants: f.grants,
    admission: f.admission,
    now: () => new Date(clock.time),
    capacity: () => ({ available: true }),
    budget: () => ({ available: true }),
    nudge: () => undefined,
    markWaitingWarning: (batchId, generation, at, tx) =>
      tx.run(sql`INSERT OR IGNORE INTO fixture_doc_warning VALUES (${batchId},${generation},${at})`)
        .changes === 1,
  };
  return new DocBatchDeliveryPump(options);
}

function batches(f: BatchFixture) {
  return f.db.select().from(canvasDocBatches).all();
}
function receipts(f: BatchFixture) {
  return f.db.select().from(sessionMessageAcceptanceReceipts).all();
}
function replay(f: BatchFixture, batchId: string, extra: Partial<DocReplayInput> = {}) {
  return replayDocBatch(f.store, f.grants, {
    documentId: f.documentId,
    batchId,
    grantId: f.grantId,
    actor: f.actor,
    now: NOW,
    ...extra,
  });
}

/** Unadmitted work the real pump expired after 24 hours. */
function expiredWork() {
  const f = batchFixture();
  databases.push(f.db);
  f.input();
  const batch = f.store.getBatch(f.batchId())!;
  // Backdated rather than waiting a day, so the fixture's grant is still current.
  f.db
    .update(canvasDocBatches)
    .set({ dueAt: new Date(Date.parse(NOW) - DAY + 1000).toISOString() })
    .run();
  const clock = { time: Date.parse(NOW) };
  const pump = pumpFor(f, clock);
  expect(pump.run().expired).toBe(1);
  return { f, batch, pump, clock };
}

/** Work started before a restart, which boot recovery marked in doubt. */
async function inDoubtWork() {
  const first = batchFixture();
  databases.push(first.db);
  first.input();
  const accepted = first.admission.admit(first.batchId());
  const prepared = await first.admission.acceptance.prepare(accepted.receipt.id);
  first.admission.acceptance.claim(accepted.receipt.id, prepared);
  first.admission.acceptance.markTurnStarted(accepted.receipt.id, 5);
  const f = batchFixture(
    ':memory:',
    null,
    { db: first.db, documentId: first.documentId, grantId: first.grantId },
    'boot-2'
  );
  const clock = { time: Date.parse(NOW) };
  const pump = pumpFor(f, clock);
  expect(await pump.resumeAccepted()).toBe(0);
  const batch = f.store.getBatch(accepted.receipt.sourceId)!;
  expect(batch.status).toBe('in_doubt');
  return { f, batch, pump, clock, receiptId: accepted.receipt.id };
}

describe('expired document work', () => {
  it('stays expired until a person replays it, then runs once as a new generation', () => {
    const { f, batch, pump, clock } = expiredWork();
    // Nothing replays on its own, however long the pump keeps running.
    for (let i = 0; i < 5; i++) {
      clock.time += 3600_000;
      expect(pump.run().admitted).toBe(0);
    }
    expect(f.store.getBatch(batch.batchId)).toMatchObject({
      status: 'expired',
      errorCode: 'manual_replay_required',
    });
    expect(receipts(f)).toEqual([]);

    const reviewed = replay(f, batch.batchId);
    expect(reviewed).toMatchObject({
      batchId: batch.batchId,
      routeId: 'route',
      previousStatus: 'expired',
    });
    const next = f.store.getBatch(reviewed.nextBatchId!)!;
    expect(next).toMatchObject({ status: 'pending', inputEventIds: batch.inputEventIds });
    expect(next.batchId).not.toBe(batch.batchId);
    expect(next.generation).not.toBe(batch.generation);
    expect(f.store.getBatch(batch.batchId)?.errorCode).toBe('manual_replay_consumed');
    const deliveries = f.db.select().from(canvasDocDeliveries).all();
    expect(deliveries.map((row) => [row.batchId, row.status])).toEqual([[next.batchId, 'pending']]);

    // A second submit is refused, not replayed twice.
    expect(() => replay(f, batch.batchId)).toThrow(
      expect.objectContaining({ code: 'WORK_ALREADY_REVIEWED', status: 409 })
    );
    expect(batches(f)).toHaveLength(2);

    clock.time = Date.parse(NOW);
    expect(pump.run().admitted).toBe(1);
    expect(pump.run().admitted).toBe(0);
    expect(receipts(f).map((row) => row.sourceId)).toEqual([next.batchId]);
    expect(new DocChannelMetrics(f.db).readCommittedSnapshot().reviewedWork).toEqual({
      awaiting: 0,
      replayed: 1,
      cleared: 0,
    });
  });

  it('cannot replay twice from a stale read: the write is conditional on the row it read', () => {
    const { f, batch, pump } = expiredWork();
    const stale = f.store.getBatch(batch.batchId)!;
    replay(f, batch.batchId);
    // The first replay is admitted, so the route is free again.
    expect(pump.run().admitted).toBe(1);
    // A second request that read the batch before the first one committed.
    const read = f.store.getBatch.bind(f.store);
    vi.spyOn(f.store, 'getBatch').mockImplementation((id, tx) =>
      id === batch.batchId ? stale : read(id, tx)
    );
    expect(() => replay(f, batch.batchId)).toThrow(
      expect.objectContaining({ code: 'WORK_ALREADY_REVIEWED' })
    );
    vi.restoreAllMocks();
    expect(batches(f)).toHaveLength(2);
    expect(receipts(f)).toHaveLength(1);
  });

  it('refuses replay without a current grant and changes nothing', () => {
    const { f, batch } = expiredWork();
    f.grants.revokeRoute(f.documentId, 'route', f.actor);
    const before = batches(f);
    expect(() => replay(f, batch.batchId)).toThrow(
      expect.objectContaining({ code: 'GRANT_REVOKED' })
    );
    expect(batches(f)).toEqual(before);
    expect(f.store.getBatch(batch.batchId)?.errorCode).toBe('manual_replay_required');
  });

  it('refuses a stale, unrelated or live batch id', () => {
    const { f, batch } = expiredWork();
    expect(() => replay(f, 'no-such-batch')).toThrow(
      expect.objectContaining({ code: 'WORK_NOT_FOUND', status: 404 })
    );
    expect(() => replay(f, batch.batchId, { documentId: 'another-document' })).toThrow();
    // Live work is not review work: newer pending input on the same route.
    f.input();
    const live = f.batchId();
    expect(() => replay(f, live)).toThrow(expect.objectContaining({ code: 'WORK_NOT_REVIEWABLE' }));
    // And while that newer work holds the route, the expired work waits its turn.
    expect(() => replay(f, batch.batchId)).toThrow(expect.objectContaining({ code: 'ROUTE_BUSY' }));
    expect(f.store.getBatch(batch.batchId)?.errorCode).toBe('manual_replay_required');
  });

  it('clears expired work once without running it', () => {
    const { f, batch, pump } = expiredWork();
    expect(
      clearDocBatch(f.store, {
        documentId: f.documentId,
        batchId: batch.batchId,
        actor: f.actor,
        now: NOW,
      })
    ).toMatchObject({ previousStatus: 'expired', nextBatchId: null });
    expect(() =>
      clearDocBatch(f.store, {
        documentId: f.documentId,
        batchId: batch.batchId,
        actor: f.actor,
        now: NOW,
      })
    ).toThrow(expect.objectContaining({ code: 'WORK_ALREADY_REVIEWED' }));
    expect(() => replay(f, batch.batchId)).toThrow(
      expect.objectContaining({ code: 'WORK_ALREADY_REVIEWED' })
    );
    expect(pump.run().admitted).toBe(0);
    expect(batches(f)).toHaveLength(1);
    expect(new DocChannelMetrics(f.db).readCommittedSnapshot().reviewedWork).toEqual({
      awaiting: 0,
      replayed: 0,
      cleared: 1,
    });
  });
});

describe('in-doubt document work', () => {
  it('is never repeated on its own, and runs again only with a person’s confirmation', async () => {
    const { f, batch, pump, clock, receiptId } = await inDoubtWork();
    for (let i = 0; i < 30; i++) {
      clock.time += 3600_000;
      expect(pump.run().admitted).toBe(0);
      expect(await pump.resumeAccepted()).toBe(0);
    }
    expect(f.store.getBatch(batch.batchId)?.status).toBe('in_doubt');
    expect(receipts(f)).toHaveLength(1);
    expect(new DocChannelMetrics(f.db).readCommittedSnapshot().reviewedWork.awaiting).toBe(1);

    const before = batches(f);
    expect(() => replay(f, batch.batchId)).toThrow(
      expect.objectContaining({ code: 'CONFIRM_REPEAT_REQUIRED' })
    );
    expect(batches(f)).toEqual(before);

    const reviewed = replay(f, batch.batchId, { confirmRepeat: true });
    expect(reviewed.previousStatus).toBe('in_doubt');
    expect(f.store.getBatch(batch.batchId)).toMatchObject({
      status: 'cancelled',
      errorCode: 'in_doubt_replayed',
    });
    const next = f.store.getBatch(reviewed.nextBatchId!)!;
    expect(next.generation).not.toBe(batch.generation);
    expect(next.inputEventIds).toEqual(batch.inputEventIds);
    // The uncertain attempt keeps its own record; nothing reopens it.
    expect(receipts(f).find((row) => row.id === receiptId)?.state).toBe('outcome_unknown');

    clock.time = Date.parse(NOW);
    expect(pump.run().admitted).toBe(1);
    expect(receipts(f)).toHaveLength(2);
    expect(receipts(f).find((row) => row.id !== receiptId)?.sourceId).toBe(next.batchId);
  });

  it('clears in-doubt work so the route can move on, without repeating it', async () => {
    const { f, batch, pump, clock, receiptId } = await inDoubtWork();
    f.input();
    const behind = f.batchId();
    clock.time += 1001;
    pump.run();
    expect(f.store.getBatch(behind)).toMatchObject({
      status: 'waiting',
      errorCode: 'active_batch',
    });
    // Newer work holds the pending slot, so a replay would have nowhere to go.
    expect(() => replay(f, batch.batchId, { confirmRepeat: true })).toThrow(
      expect.objectContaining({ code: 'ROUTE_BUSY' })
    );

    const cleared = clearDocBatch(f.store, {
      documentId: f.documentId,
      batchId: batch.batchId,
      actor: f.actor,
      now: NOW,
    });
    expect(cleared).toMatchObject({ previousStatus: 'in_doubt', nextBatchId: null });
    expect(f.store.getBatch(batch.batchId)).toMatchObject({
      status: 'cancelled',
      errorCode: 'in_doubt_cleared',
    });
    const old = f.db
      .select()
      .from(canvasDocDeliveries)
      .where(eq(canvasDocDeliveries.batchId, batch.batchId))
      .all();
    expect(
      old.every((row) => row.status === 'cancelled' && row.reason === 'in_doubt_cleared')
    ).toBe(true);
    expect(receipts(f).find((row) => row.id === receiptId)?.state).toBe('outcome_unknown');

    clock.time += 60_001;
    expect(pump.run().admitted).toBe(1);
    expect(receipts(f).filter((row) => row.sourceId === batch.batchId)).toHaveLength(1);
    expect(() => replay(f, batch.batchId, { confirmRepeat: true })).toThrow(
      expect.objectContaining({ code: 'WORK_ALREADY_REVIEWED' })
    );
  });
});
