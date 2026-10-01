/** Admission composition preserves generation and canonical scope while keeping overflow pending. */
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createDb, runMigrations, sql, type Db, type DbTransaction } from '@dorkos/db';
import { DocChannelStore } from '../store.js';
import { DocChannelIngest } from '../ingest.js';
import { admitBatchSlice, selectBatchSlice } from '../coalescer.js';
import type { DocIngestAccess } from '../ingest-types.js';
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.$client.close();
});
function fixture() {
  const db = createDb(':memory:');
  dbs.push(db);
  runMigrations(db);
  const store = new DocChannelStore(db);
  const now = '2026-10-01T12:00:00.000Z';
  store.initialize({
    documentId: 'doc',
    scope: 'session:placeholder',
    createdAt: now,
    updatedAt: now,
  });
  const route = {
    id: 'route',
    on: 'task.*',
    to: 'agent:owner' as const,
    turn: { mode: 'coalesce' as const, windowMs: 1000, maxBatch: 1 },
  };
  store.insertGrant({
    grantId: 'grant',
    documentId: 'doc',
    routeId: 'route',
    normalizedRoute: route,
    routeHash: 'a'.repeat(64),
    declarationHash: 'b'.repeat(64),
    approvedBy: 'owner',
    approvalEvidence: {},
    allowedTypes: ['task.*'],
    limits: { envelopeBytes: 16384, eventsPerMinute: 60, turnsPerHour: 10 },
    createdAt: now,
  });
  const access: DocIngestAccess = {
    documentId: 'doc',
    scope: 'session:placeholder',
    documentLabel: 'Tasks',
    provenance: {},
    routes: [{ route, grantId: 'grant', grantRevision: 1 }],
  };
  const ingest = new DocChannelIngest(store, () => new Date(now));
  const inputs = Array.from({ length: 2 }, () => ({
    v: 1 as const,
    id: randomUUID(),
    type: 'task.comment',
    payload: { text: 'hello' },
  }));
  for (const input of inputs) ingest.accept(input, () => access);
  const id = db.get<{ id: string }>(
    sql`SELECT batch_id AS id FROM canvas_doc_batches WHERE status='pending'`
  )!.id;
  return { db, store, now, inputs, batch: store.getBatch(id)! };
}
it('overflow inherits final canonical scope and preserves its fixed deadline', () => {
  const f = fixture();
  admitBatchSlice(f.store, f.batch.batchId, 1, 'Tasks', f.now, (tx) => {
    tx.run(sql`UPDATE canvas_doc_channels SET scope='session:canonical' WHERE document_id='doc'`);
    tx.run(
      sql`UPDATE canvas_doc_batches SET scope='session:canonical',status='accepted' WHERE batch_id=${f.batch.batchId}`
    );
  });
  const overflowId = f.db.get<{ id: string }>(
    sql`SELECT batch_id AS id FROM canvas_doc_batches WHERE status='pending'`
  )!.id;
  expect(f.store.getBatch(overflowId)!.scope).toBe('session:canonical');
  expect(f.store.getBatch(overflowId)!.dueAt).toBe(f.batch.dueAt);
  expect(f.store.getBatch(f.batch.batchId)!.generation).toBe(f.batch.generation);
  expect(f.store.getBatch(f.batch.batchId)!.inputEventIds).toEqual([f.inputs[0]!.id]);
});
it('a callback cannot replace selected identity/generation and all changes roll back', () => {
  const f = fixture();
  expect(() =>
    admitBatchSlice(f.store, f.batch.batchId, 1, 'Tasks', f.now, (tx) => {
      tx.run(
        sql`UPDATE canvas_doc_batches SET generation='different',status='accepted' WHERE batch_id=${f.batch.batchId}`
      );
    })
  ).toThrow('Admission changed original input identity');
  expect(f.store.getBatch(f.batch.batchId)).toEqual(f.batch);
});
it('selection refuses a missing or compacted input instead of dropping it or inventing payload', () => {
  const f = fixture();
  f.db.run(
    sql`UPDATE canvas_doc_events SET payload='null',payload_pruned_at=${f.now} WHERE event_id=${f.inputs[0]!.id}`
  );
  expect(() =>
    f.store.transaction((tx) => selectBatchSlice(f.store, tx, f.batch, 1, 'Tasks'))
  ).toThrow('Invalid stored document channel record');
});

it('rolls back async admission and prevents its delayed transaction mutation', async () => {
  const f = fixture();
  const invalidAdmission = async (tx: DbTransaction) => {
    tx.run(sql`UPDATE canvas_doc_batches SET status='accepted' WHERE batch_id=${f.batch.batchId}`);
    await Promise.resolve();
    tx.run(sql`UPDATE canvas_doc_channels SET scope='session:escaped' WHERE document_id='doc'`);
  };
  expect(() =>
    admitBatchSlice(
      f.store,
      f.batch.batchId,
      1,
      'Tasks',
      f.now,
      // @ts-expect-error Deliberately probe an unsafe callback at the runtime boundary.
      invalidAdmission
    )
  ).toThrow('must be synchronous');
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.store.getChannel('doc')?.scope).toBe('session:placeholder');
  expect(f.store.getBatch(f.batch.batchId)).toMatchObject({
    status: 'pending',
    inputEventIds: f.inputs.map((input) => input.id),
  });
  expect(
    f.db.get<{ count: number }>(sql`SELECT count(*) AS count FROM canvas_doc_batches`)?.count
  ).toBe(1);
});
