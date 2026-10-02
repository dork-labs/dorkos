import { addAcceptedReceiptPage } from './accepted-page-fixtures.js';
/** Real migrated file SQLite recovery pages, including races across independent connections. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  canvasDocChannels,
  canvasDocBatches,
  sessionMessageAcceptanceReceipts,
  sessionMessageQueue,
  createDb,
  eq,
  type Db,
} from '@dorkos/db';
import { batchFixture, NOW, FROM, TO, type BatchFixture } from './batch-fixtures.js';
import { DocChannelIngest } from '../ingest.js';
import { consumeAcceptedDocWakes, DOC_RESUME_RETRY_CODE } from '../delivery/resume.js';
const dbs: Db[] = [];
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) if (db.$client.open) db.$client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'doc-recovery-page-'));
  dirs.push(dir);
  const file = join(dir, 'state.db');
  const f = batchFixture(file);
  dbs.push(f.db);
  return {
    f,
    file,
    options: { db: f.db, store: f.store, admission: f.admission, now: () => new Date(NOW) },
  };
}
function add(f: BatchFixture, index: number, acceptedAt = NOW) {
  const doc = f.canvas.open(FROM, 'agent-1', {
    type: 'markdown',
    title: `Tasks ${index}`,
    content: `Body ${index}`,
  });
  f.canvas.pin(FROM, doc.id, true);
  f.db
    .update(canvasDocChannels)
    .set({ openerAgentId: 'agent-1' })
    .where(eq(canvasDocChannels.documentId, doc.id))
    .run();
  f.grants.configure(
    doc.id,
    {
      routes: [
        {
          id: 'route',
          on: 'task.*',
          to: 'agent:owner',
          turn: { mode: 'immediate', maxBatch: 100 },
        },
      ],
    },
    f.actor
  );
  f.grants.grant(
    { documentId: doc.id, routeId: 'route', expiresAt: '2026-10-02T00:00:00.000Z' },
    f.actor
  );
  const input = new DocChannelIngest(f.store, () => new Date(NOW)).accept(
    { v: 1, id: randomUUID(), type: 'task.changed', payload: { index } },
    (tx) => ({
      documentId: doc.id,
      scope: FROM,
      documentLabel: doc.title,
      provenance: {},
      routes: f.grants.getCurrentRoutes(doc.id, 'task.changed', f.actor, tx),
    })
  );
  const batchId = input.deliveries[0]!.batchId!;
  const receipt = f.admission.admit(batchId).receipt;
  f.db
    .update(sessionMessageAcceptanceReceipts)
    .set({ acceptedAt })
    .where(eq(sessionMessageAcceptanceReceipts.id, receipt.id))
    .run();
  return { ...receipt, acceptedAt };
}
it('bounds 105 same-session receipts by immutable keyset and wraps to newly inserted earlier keys after restart', async () => {
  const { f, file, options } = fixture();
  const rows = addAcceptedReceiptPage(f, 105);
  expect(rows).toHaveLength(105);
  expect(new Set(rows.map((row) => row.id)).size).toBe(105);
  expect(new Set(rows.map((row) => row.sourceId)).size).toBe(105);
  expect(
    new Set(
      f.db
        .select()
        .from(canvasDocBatches)
        .all()
        .map((row) => row.grantId)
    ).size
  ).toBe(105);
  const prepare = vi.spyOn(f.admission.acceptance, 'prepare');
  const first = await consumeAcceptedDocWakes(options);
  expect(first.selected).toBe(100);
  expect(first.hasMore).toBe(true);
  expect(first.notifications.size).toBe(1);
  expect(first.notifications.get('session-1')).toHaveLength(100);
  expect(prepare).toHaveBeenCalledTimes(100);
  const second = await consumeAcceptedDocWakes(options, first.cursor);
  expect(second.selected).toBe(5);
  expect(prepare).toHaveBeenCalledTimes(105);
  expect(second.hasMore).toBe(false);
  expect(
    new Set(
      [...first.notifications.values()].flat().concat([...second.notifications.values()].flat())
    ).size
  ).toBe(105);
  expect(second.nextEligibleAt).toBe(new Date(Date.parse(NOW) + 60000).toISOString());
  const earlier = add(f, 999, new Date(Date.parse(NOW) - 1000).toISOString());
  f.db.$client.close();
  const db = createDb(file);
  dbs.push(db);
  const reboot = batchFixture(
    file,
    null,
    { db, documentId: f.documentId, grantId: f.grantId },
    'boot-2'
  );
  const wrap = await consumeAcceptedDocWakes({
    ...options,
    db,
    store: reboot.store,
    admission: reboot.admission,
  });
  expect(wrap.selected).toBe(1);
  expect([...wrap.notifications.values()].flat()).toEqual([earlier.id]);
  expect(db.select().from(sessionMessageAcceptanceReceipts).all()).toHaveLength(rows.length + 1);
});
it('continues past first and middle transient refusals while preserving prior success notifications and identity', async () => {
  const { f, options } = fixture();
  const receipts = Array.from({ length: 5 }, (_, i) =>
    add(f, i, new Date(Date.parse(NOW) + i).toISOString())
  );
  const before = f.db.select().from(sessionMessageAcceptanceReceipts).all();
  const queue = f.db.select().from(sessionMessageQueue).all();
  const original = f.admission.acceptance.prepare.bind(f.admission.acceptance);
  vi.spyOn(f.admission.acceptance, 'prepare').mockImplementation(async (id) => {
    if ([receipts[0]!.id, receipts[2]!.id].includes(id)) throw new Error('storage unavailable');
    return original(id);
  });
  const page = await consumeAcceptedDocWakes(options);
  expect(page.selected).toBe(5);
  expect(page.retryableFailures).toBe(2);
  expect([...page.notifications.values()].flat()).toEqual([
    receipts[1]!.id,
    receipts[3]!.id,
    receipts[4]!.id,
  ]);
  expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual(before);
  expect(f.db.select().from(sessionMessageQueue).all()).toEqual(queue);
  expect(page.nextEligibleAt).toBe(new Date(Date.parse(NOW) + 60000).toISOString());
  expect(
    f.db
      .select()
      .from(canvasDocBatches)
      .all()
      .every(
        (b) => b.status === 'accepted' && b.errorCode === DOC_RESUME_RETRY_CODE && b.attempt === 0
      )
  ).toBe(true);
});
it('returns only one committed wake under competing file connections', async () => {
  const { f, file, options } = fixture();
  const receipt = add(f, 1);
  const db = createDb(file);
  dbs.push(db);
  const other = batchFixture(file, null, { db, documentId: f.documentId, grantId: f.grantId });
  const pages = await Promise.all([
    consumeAcceptedDocWakes(options),
    consumeAcceptedDocWakes({ ...options, db, store: other.store, admission: other.admission }),
  ]);
  expect(pages.flatMap((p) => [...p.notifications.values()].flat())).toEqual([receipt.id]);
  expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()[0]!.state).toBe('accepted');
});
it('uses the fresh canonical session after real lifecycle rekey during awaited preparation', async () => {
  const { f, options } = fixture();
  const receipt = add(f, 1);
  const original = f.admission.acceptance.prepare.bind(f.admission.acceptance);
  vi.spyOn(f.admission.acceptance, 'prepare').mockImplementation(async (id) => {
    const prepared = await original(id);
    f.documents.rekeyScope(FROM, TO);
    return prepared;
  });
  const page = await consumeAcceptedDocWakes(options);
  expect([...page.notifications]).toEqual([['canonical', [receipt.id]]]);
  expect(f.store.getBatch(receipt.sourceId)).toMatchObject({
    scope: TO,
    generation: receipt.sourceGeneration,
    admissionReceiptId: receipt.id,
  });
});
it('bounds integrity work separately and preserves damage when actual coordinator cancellation refuses', async () => {
  const { f, options } = fixture();
  const first = add(f, 1);
  const second = add(f, 2);
  f.db.update(canvasDocBatches).set({ admissionReceiptId: null }).run();
  const original = f.admission.acceptance.prepare.bind(f.admission.acceptance);
  vi.spyOn(f.admission.acceptance, 'prepare').mockImplementation(async (id) => {
    if (id === first.id) throw new Error('unavailable integrity recovery');
    return original(id);
  });
  const page = await consumeAcceptedDocWakes(options, undefined, 1);
  expect(page.selected).toBe(0);
  expect(page.hasIntegrityMore).toBe(true);
  const next = await consumeAcceptedDocWakes(options, undefined, 1, page.integrityCursor);
  expect(next.hasIntegrityMore).toBe(false);
  expect(
    f.db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(eq(sessionMessageAcceptanceReceipts.id, first.id))
      .get()!.state
  ).toBe('accepted');
  expect(
    f.db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(eq(sessionMessageAcceptanceReceipts.id, second.id))
      .get()!.state
  ).toBe('accepted');
  expect(next.retryableFailures).toBe(1);
  expect(next.nextEligibleAt).toBe(new Date(Date.parse(NOW) + 60000).toISOString());
});
it('rejects invalid bounds and cursors without preparing work', async () => {
  const { f, options } = fixture();
  const prepare = vi.spyOn(f.admission.acceptance, 'prepare');
  for (const limit of [0, 101, 1.5])
    await expect(consumeAcceptedDocWakes(options, undefined, limit)).rejects.toThrow(RangeError);
  await expect(consumeAcceptedDocWakes(options, { acceptedAt: 'bad', id: 'id' })).rejects.toThrow(
    RangeError
  );
  expect(prepare).not.toHaveBeenCalled();
});

it('cancels a proven permanent grant refusal only through the real coordinator', async () => {
  const { f, options } = fixture();
  const receipt = add(f, 1);
  f.grants.revoke(
    f.store.getBatch(receipt.sourceId)!.documentId,
    f.store.getBatch(receipt.sourceId)!.grantId,
    f.actor
  );
  const page = await consumeAcceptedDocWakes(options);
  expect(page.notifications.size).toBe(0);
  expect(page.retryableFailures).toBe(0);
  expect(
    f.db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(eq(sessionMessageAcceptanceReceipts.id, receipt.id))
      .get()!.state
  ).toBe('cancelled');
  expect(f.store.getBatch(receipt.sourceId)!.status).toBe('cancelled');
  expect(f.db.select().from(sessionMessageQueue).all()).toEqual([]);
});

it('flushes earlier notifications when a later wake write fails and bounds the failed-row retry', async () => {
  const { f, options } = fixture();
  const rows = Array.from({ length: 3 }, (_, i) =>
    add(f, i, new Date(Date.parse(NOW) + i).toISOString())
  );
  f.db.$client.exec(`CREATE TRIGGER refuse_wake BEFORE UPDATE OF lease_until ON canvas_doc_batches
    WHEN NEW.batch_id='${rows[1]!.sourceId}' BEGIN SELECT RAISE(ABORT,'wake storage unavailable'); END`);
  const page = await consumeAcceptedDocWakes(options);
  expect([...page.notifications.values()].flat()).toEqual([rows[0]!.id, rows[2]!.id]);
  expect(page.retryableFailures).toBe(1);
  expect(page.nextEligibleAt).toBe(new Date(Date.parse(NOW) + 60000).toISOString());
  expect(f.store.getBatch(rows[1]!.sourceId)).toMatchObject({
    status: 'accepted',
    generation: rows[1]!.sourceGeneration,
    leaseUntil: null,
    attempt: 0,
  });
  expect(f.db.select().from(sessionMessageQueue).all()).toHaveLength(3);
});
