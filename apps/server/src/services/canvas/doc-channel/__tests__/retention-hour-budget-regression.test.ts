/** Real rolling-turn evidence survives completed-history caps, restart and lowered age policy. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createDb,
  eq,
  sql,
  canvasDocEvents,
  sessionMessageAcceptanceReceipts,
  type Db,
} from '@dorkos/db';
import { batchFixture, NOW } from './batch-fixtures.js';
import { retainDocHistory } from '../retention.js';
const databases: Db[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.$client.open) db.$client.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it.each(['ok', 'failed'] as const)(
  'keeps the actual %s started-turn ledger across cap sweep, restart and short-age sweep until the exact hour',
  async (outcome) => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-retention-hour-'));
    directories.push(dir);
    const file = join(dir, 'state.db');
    let at = Date.parse(NOW);
    let f = batchFixture(
      file,
      null,
      undefined,
      'boot-1',
      'claude-code',
      () => new Date(at),
      undefined,
      { turnsPerHour: 1 }
    );
    databases.push(f.db);
    const input = f.input();
    const first = f.admission.admit(f.batchId());
    const preparedFirst = await f.admission.acceptance.prepare(first.receipt.id);
    f.admission.acceptance.claim(first.receipt.id, preparedFirst);
    f.admission.acceptance.markTurnStarted(first.receipt.id, 1);
    f.admission.acceptance.settle(first.receipt.id, outcome);
    const completed = f.store.getBatch(first.receipt.sourceId)!;
    expect(completed.status).toBe(outcome === 'ok' ? 'turn_done' : 'failed');
    retainDocHistory(f.store, NOW, { documentBytes: 1, installationBytes: 1 });
    expect(f.store.getEvent(f.documentId, input.receipt.id)).toBeUndefined();
    expect(f.store.listDeliveries(f.documentId, input.receipt.id)).toEqual([]);
    expect(f.store.getBatch(completed.batchId)).toEqual(completed);
    const identity = { documentId: f.documentId, grantId: f.grantId };
    f.db.$client.close();
    const db = createDb(file);
    databases.push(db);
    at += 120_000;
    f = batchFixture(file, null, { db, ...identity }, 'boot-2', 'claude-code', () => new Date(at));
    retainDocHistory(f.store, new Date(at).toISOString(), {
      ageMs: 60_000,
      documentBytes: 1,
      installationBytes: 1,
    });
    expect(f.store.getBatch(completed.batchId)).toEqual(completed);
    f.input();
    const second = f.admission.admit(f.batchId());
    const preparedSecond = await f.admission.acceptance.prepare(second.receipt.id);
    const before = db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(eq(sessionMessageAcceptanceReceipts.id, second.receipt.id))
      .get()!;
    const queued = f.queue.get(before.queueMessageId);
    const boundary = new Date(Date.parse(NOW) + 3600_000).toISOString();
    expect(f.admission.acceptance.claim(second.receipt.id, preparedSecond)).toMatchObject({
      deferred: true,
      nextEligibleAt: boundary,
    });
    const after = db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(eq(sessionMessageAcceptanceReceipts.id, second.receipt.id))
      .get()!;
    expect(after).toMatchObject({
      id: before.id,
      state: 'accepted',
      sourceId: before.sourceId,
      sourceGeneration: before.sourceGeneration,
      originAuthorityDigest: before.originAuthorityDigest,
      queueMessageId: before.queueMessageId,
      dispatchAttemptId: null,
    });
    expect(f.queue.get(before.queueMessageId)).toEqual(queued);
    at = Date.parse(boundary);
    retainDocHistory(f.store, boundary, { ageMs: 60_000, documentBytes: 1, installationBytes: 1 });
    expect(f.store.getBatch(completed.batchId)).toBeUndefined();
    expect(f.store.getBatch(second.receipt.sourceId)?.status).toBe('accepted');
    expect(f.admission.acceptance.claim(second.receipt.id, preparedSecond)).toMatchObject({
      dispatchAttemptId: expect.any(String),
    });
  }
);

function freshFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'doc-retention-controls-'));
  directories.push(dir);
  let at = Date.parse(NOW);
  const f = batchFixture(
    join(dir, 'state.db'),
    null,
    undefined,
    'boot-1',
    'claude-code',
    () => new Date(at),
    undefined,
    { turnsPerHour: 1 }
  );
  databases.push(f.db);
  return {
    f,
    advance: (value: string) => {
      at = Date.parse(value);
    },
  };
}
async function startAndSettle(f: ReturnType<typeof batchFixture>) {
  const accepted = f.admission.admit(f.batchId());
  const prepared = await f.admission.acceptance.prepare(accepted.receipt.id);
  expect(f.admission.acceptance.claim(accepted.receipt.id, prepared)).toMatchObject({
    dispatchAttemptId: expect.any(String),
  });
  f.admission.acceptance.markTurnStarted(accepted.receipt.id, 1);
  f.admission.acceptance.settle(accepted.receipt.id, 'ok');
  return accepted.receipt;
}
it('removes actual cancelled no-start work and retains no invented turn charge', () => {
  const { f } = freshFixture();
  const input = f.input();
  const accepted = f.admission.admit(f.batchId());
  f.admission.acceptance.cancel(accepted.receipt.id, 'source_expired');
  expect(f.store.getBatch(accepted.receipt.sourceId)?.status).toBe('cancelled');
  expect(
    f.db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
      .get()?.turnStartedAt
  ).toBeNull();
  retainDocHistory(f.store, NOW, { ageMs: 1, documentBytes: 1, installationBytes: 1 });
  expect(f.store.getBatch(accepted.receipt.sourceId)).toBeUndefined();
  expect(f.store.getEvent(f.documentId, input.receipt.id)).toBeUndefined();
});
it.each(['pending', 'waiting', 'accepted', 'dispatching', 'turn_started', 'in_doubt'] as const)(
  'preserves real %s batch/input/delivery authority under age and cap pressure',
  async (status) => {
    const { f } = freshFixture();
    const input = f.input();
    const id = f.batchId();
    if (status === 'waiting') {
      const batch = f.store.getBatch(id)!;
      expect(
        f.store.transitionBatch({
          batchId: id,
          generation: batch.generation,
          attempt: batch.attempt,
          expectedStatus: 'pending',
          status: 'waiting',
          updatedAt: NOW,
        })
      ).toBe(true);
    } else if (status !== 'pending') {
      const accepted = f.admission.admit(id);
      if (status !== 'accepted') {
        const prepared = await f.admission.acceptance.prepare(accepted.receipt.id);
        f.admission.acceptance.claim(accepted.receipt.id, prepared);
        if (status === 'turn_started')
          f.admission.acceptance.markTurnStarted(accepted.receipt.id, 1);
        if (status === 'in_doubt')
          f.admission.acceptance.markOutcomeUnknown(accepted.receipt.id, 'unknown_effect');
      }
    }
    expect(f.store.getBatch(id)?.status).toBe(status);
    const before = {
      batch: f.store.getBatch(id),
      event: f.store.getEvent(f.documentId, input.receipt.id),
      deliveries: f.store.listDeliveries(f.documentId, input.receipt.id),
    };
    retainDocHistory(f.store, '2026-10-01T14:00:00.000Z', {
      ageMs: 1,
      documentBytes: 1,
      installationBytes: 1,
    });
    expect({
      batch: f.store.getBatch(id),
      event: f.store.getEvent(f.documentId, input.receipt.id),
      deliveries: f.store.listDeliveries(f.documentId, input.receipt.id),
    }).toEqual(before);
  }
);
it('rolls back early orphan cleanup, accounting backfill, compaction and floors on a later SQLite failure', async () => {
  const { f, advance } = freshFixture();
  f.input();
  const first = await startAndSettle(f);
  retainDocHistory(f.store, NOW, { documentBytes: 1, installationBytes: 1 });
  expect(f.store.getBatch(first.sourceId)).toBeDefined();
  const later = new Date(Date.parse(NOW) + 3600_000 + 120_000).toISOString();
  advance(later);
  const input = f.input();
  const second = await startAndSettle(f);
  f.db
    .update(canvasDocEvents)
    .set({ envelopeBytes: 0 })
    .where(eq(canvasDocEvents.eventId, input.receipt.id))
    .run();
  const tables = [
    'canvas_doc_events',
    'canvas_doc_deliveries',
    'canvas_doc_batches',
    'canvas_doc_channels',
    'session_message_acceptance_receipts',
  ] as const;
  const snapshot = () =>
    tables.map((table) => f.db.$client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = snapshot();
  f.db.run(
    sql`CREATE TRIGGER fail_hour_retention_floor BEFORE UPDATE OF retention_floor ON canvas_doc_channels BEGIN SELECT RAISE(ABORT,'retention floor failure'); END`
  );
  expect(() =>
    retainDocHistory(f.store, later, { ageMs: 60_000, documentBytes: 1, installationBytes: 1 })
  ).toThrow('retention floor failure');
  expect(snapshot()).toEqual(before);
  f.db.run(sql`DROP TRIGGER fail_hour_retention_floor`);
  retainDocHistory(f.store, later, { ageMs: 60_000, documentBytes: 1, installationBytes: 1 });
  expect(f.store.getBatch(first.sourceId)).toBeUndefined();
  expect(f.store.getEvent(f.documentId, input.receipt.id)).toBeUndefined();
  expect(f.store.getBatch(second.sourceId)?.status).toBe('turn_done');
});

// The paid SDK process alone is replaced. Authority comes from the real original constructor/FILE DB.
const nativeRetentionSdk = vi.hoisted(() => ({
  options: [] as unknown[],
  prompts: [] as unknown[],
  parked: true,
  release: undefined as (() => void) | undefined,
}));
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options: unknown) {
      nativeRetentionSdk.options.push(options);
    }
    startThread() {
      return {
        id: 'native-retention-source',
        runStreamed: async (prompt: unknown) => {
          nativeRetentionSdk.prompts.push(prompt);
          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 'native-retention-source' };
              if (nativeRetentionSdk.parked)
                await new Promise<void>((resolve) => {
                  nativeRetentionSdk.release = resolve;
                });
              yield {
                type: 'turn.completed',
                usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
              };
            })(),
          };
        },
      };
    }
    resumeThread() {
      return this.startThread();
    }
  },
}));
import { nativeCommittedCodexRoomFixture } from '../writes/__tests__/authority-fixtures.js';
function originalNativeRetentionSource(disposition: 'settled' | 'unpulled' = 'settled') {
  nativeRetentionSdk.options.length = 0;
  nativeRetentionSdk.prompts.length = 0;
  nativeRetentionSdk.parked = true;
  nativeRetentionSdk.release = undefined;
  return nativeCommittedCodexRoomFixture(
    {
      options: nativeRetentionSdk.options,
      prompts: nativeRetentionSdk.prompts,
      releaseProducer: () => nativeRetentionSdk.release?.(),
      completeFutureTurns: () => {
        nativeRetentionSdk.parked = false;
      },
    },
    disposition
  );
}

it('retains genuine native COMMIT/spend evidence through an expired-hour sweep without refund or native reissue', async () => {
  const h = await originalNativeRetentionSource();
  let failed = false,
    first: unknown;
  try {
    const admission = h.db.all(
      sql`SELECT * FROM room_doc_admissions WHERE admission_id=${h.admission.admission_id}`
    );
    const spend = h.db.all(sql`SELECT * FROM room_turn_spend`);
    const batchId = h.http.channels.listDeliveries(h.documentId, h.input.id)[0]!.batchId!;
    const batch = h.http.channels.getBatch(batchId)!;
    retainDocHistory(h.http.channels, new Date(Date.now() + 3600_001).toISOString(), {
      ageMs: 1,
      documentBytes: 1,
      installationBytes: 1,
    });
    expect(
      h.db.all(
        sql`SELECT * FROM room_doc_admissions WHERE admission_id=${h.admission.admission_id}`
      )
    ).toEqual(admission);
    expect(h.db.all(sql`SELECT * FROM room_turn_spend`)).toEqual(spend);
    expect(h.http.channels.getBatch(batchId)).toEqual(batch);
    expect(h.http.channels.getEvent(h.documentId, h.input.id)).toBeDefined();
    expect(nativeRetentionSdk.prompts).toHaveLength(2);
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    try {
      await h.cleanup();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  }
  if (failed) throw first;
});
