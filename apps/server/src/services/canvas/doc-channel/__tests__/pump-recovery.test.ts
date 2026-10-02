/** File SQLite restart through the actual document source, coordinator and dispatcher. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  createDb,
  sql,
  eq,
  canvasDocChannels,
  canvasDocBatches,
  sessionMessageAcceptanceReceipts,
  sessionMessageQueue,
  type Db,
} from '@dorkos/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { randomUUID } from 'node:crypto';
import type { StreamEvent } from '@dorkos/shared/types';
import type { CanvasChannelDeclaration } from '@dorkos/shared/canvas-channel-schemas';
import { batchFixture, NOW, FROM, TO, type BatchFixture } from './batch-fixtures.js';
import { DocBatchDeliveryPump, type DocBatchPumpOptions } from '../delivery/pump.js';
import { DocChannelIngest } from '../ingest.js';
import {
  adoptAcceptedPrivateMessages,
  resetMessageDispatcher,
  noteRuntimeTurnOpen,
  noteRuntimeTurnClosed,
} from '../../../session/message-dispatcher.js';
import { setPrivateSessionMessageAcceptanceService } from '../../../session/private-messages/acceptance.js';
import { setMessageQueueStore } from '../../../session/message-queue-store.js';
import {
  disposeProjector,
  getOrCreateProjector,
} from '../../../session/session-state-projector.js';
const databases: Db[] = [];
const nativeConnections: Database.Database[] = [];
const directories: string[] = [];
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 50));
}
afterEach(async () => {
  await settle();
  resetMessageDispatcher();
  setPrivateSessionMessageAcceptanceService(undefined);
  setMessageQueueStore(undefined);
  disposeProjector('session-1');
  disposeProjector('canonical');
  for (const db of databases.splice(0)) db.$client.close();
  for (const connection of nativeConnections.splice(0)) connection.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function options(
  f: BatchFixture,
  now: () => Date,
  nudge: (id: string) => undefined
): DocBatchPumpOptions {
  f.db.$client.exec(
    'CREATE TABLE IF NOT EXISTS fixture_doc_warning (batch_id TEXT, generation TEXT, warned_at TEXT, PRIMARY KEY(batch_id,generation))'
  );
  return {
    db: f.db,
    store: f.store,
    grants: f.grants,
    admission: f.admission,
    now,
    capacity: () => ({ available: true }),
    budget: () => ({ available: true }),
    nudge,
    markWaitingWarning: (id, generation, at, tx) =>
      tx.run(sql`INSERT OR IGNORE INTO fixture_doc_warning VALUES (${id},${generation},${at})`)
        .changes === 1,
  };
}
describe('document pump identity and recovery', () => {
  it('accepts while the first turn is busy, rekeys, reopens the database and dispatches exactly once after release', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-pump-restart-'));
    directories.push(dir);
    const file = join(dir, 'state.db');
    let time = Date.parse(NOW);
    const now = () => new Date(time);
    const f = batchFixture(file, null, undefined, 'boot-1', 'claude-code', now);
    f.input();
    time += 1001;
    const busy = new FakeAgentRuntime('claude-code');
    busy.getInternalSessionId.mockReturnValue(undefined);
    setMessageQueueStore(f.queue);
    setPrivateSessionMessageAcceptanceService(f.admission.acceptance);
    noteRuntimeTurnOpen('session-1');
    const pump = new DocBatchDeliveryPump(
      options(f, now, (id) => {
        adoptAcceptedPrivateMessages({
          sessionId: id,
          projector: getOrCreateProjector(id),
          runtime: busy,
        });
        return undefined;
      })
    );
    expect(pump.run().admitted).toBe(1);
    await settle();
    expect(busy.sendMessage).not.toHaveBeenCalled();
    const original = f.db.select().from(sessionMessageAcceptanceReceipts).all()[0]!;
    f.documents.rekeyScope(FROM, TO);
    resetMessageDispatcher();
    disposeProjector('session-1');
    f.db.$client.close();
    const db = createDb(file);
    databases.push(db);
    const reboot = batchFixture(
      file,
      null,
      { db, documentId: f.documentId, grantId: f.grantId },
      'boot-2',
      'claude-code',
      now
    );
    const runtime = new FakeAgentRuntime('claude-code');
    runtime.getInternalSessionId.mockReturnValue(undefined);
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} };
      },
    ]);
    setMessageQueueStore(reboot.queue);
    setPrivateSessionMessageAcceptanceService(reboot.admission.acceptance);
    const resumed = new DocBatchDeliveryPump(
      options(reboot, now, (id) => {
        adoptAcceptedPrivateMessages({
          sessionId: id,
          projector: getOrCreateProjector(id),
          runtime,
        });
        return undefined;
      })
    );
    noteRuntimeTurnOpen('canonical');
    expect(await resumed.resumeAccepted()).toBe(1);
    expect(await resumed.resumeAccepted()).toBe(0);
    await settle();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    noteRuntimeTurnClosed('canonical');
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.sendMessage.mock.calls[0]?.[0]).toBe('canonical');
    const receipts = db.select().from(sessionMessageAcceptanceReceipts).all();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      id: original.id,
      sourceId: original.sourceId,
      sourceGeneration: original.sourceGeneration,
      queueMessageId: original.queueMessageId,
      originAgentPath: original.originAgentPath,
      sessionId: 'canonical',
      state: 'settled',
    });
    expect(db.select().from(sessionMessageQueue).all()).toEqual([]);
    expect(reboot.store.getBatch(original.sourceId)?.scope).toBe(TO);
  });
  it('consumes an accepted deadline once while busy and advances its scheduler wake without changing durable identity', async () => {
    let time = Date.parse(NOW);
    const now = () => new Date(time);
    const f = batchFixture(':memory:', null, undefined, 'boot-1', 'claude-code', now);
    databases.push(f.db);
    f.input();
    time += 1001;
    const runtime = new FakeAgentRuntime('claude-code');
    runtime.getInternalSessionId.mockReturnValue(undefined);
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} };
      },
    ]);
    setMessageQueueStore(f.queue);
    setPrivateSessionMessageAcceptanceService(f.admission.acceptance);
    noteRuntimeTurnOpen('session-1');
    let nudges = 0;
    const configuration = options(f, now, (id) => {
      nudges++;
      adoptAcceptedPrivateMessages({ sessionId: id, projector: getOrCreateProjector(id), runtime });
      return undefined;
    });
    const pump = new DocBatchDeliveryPump(configuration);
    expect(pump.run().admitted).toBe(1);
    await settle();
    const original = f.db.select().from(sessionMessageAcceptanceReceipts).all()[0]!;
    const before = f.store.getBatch(original.sourceId)!;
    const deadline = new Date(time + 60000).toISOString();
    f.db
      .update(canvasDocBatches)
      .set({ leaseUntil: deadline, errorCode: 'document_final_budget_defer' })
      .where(eq(canvasDocBatches.batchId, before.batchId))
      .run();
    expect(await pump.resumeAccepted()).toBe(0);
    expect(pump.run().nextEligibleAt).toBe(deadline);
    time += 60001;
    nudges = 0;
    const competing = new DocBatchDeliveryPump(configuration);
    const resumed = await Promise.all([pump.resumeAccepted(), competing.resumeAccepted()]);
    expect(resumed.sort()).toEqual([0, 1]);
    const next = new Date(time + 60000).toISOString();
    expect(pump.run().nextEligibleAt).toBe(next);
    expect(pump.run().nextEligibleAt).toBe(next);
    expect(await pump.resumeAccepted()).toBe(0);
    expect(nudges).toBe(1);
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([original]);
    expect(f.store.getBatch(original.sourceId)).toMatchObject({
      batchId: before.batchId,
      generation: before.generation,
      scope: before.scope,
      admissionReceiptId: original.id,
      status: 'accepted',
      leaseUntil: next,
      errorCode: 'document_resume_retry',
    });
    expect(f.db.select().from(sessionMessageQueue).all()[0]?.id).toBe(original.queueMessageId);
    await settle();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    // A scheduler retry wake cannot postpone the existing dispatcher's actual capacity release.
    noteRuntimeTurnClosed('session-1');
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()[0]).toMatchObject({
      id: original.id,
      state: 'settled',
    });
  });
  it('retains accepted identity and its original deadline when consuming the wake cannot commit', async () => {
    let time = Date.parse(NOW);
    const now = () => new Date(time);
    const f = batchFixture(':memory:', null, undefined, 'boot-1', 'claude-code', now);
    databases.push(f.db);
    f.input();
    time += 1001;
    let nudges = 0;
    const pump = new DocBatchDeliveryPump(
      options(f, now, () => {
        nudges++;
        return undefined;
      })
    );
    pump.run();
    const original = f.db.select().from(sessionMessageAcceptanceReceipts).all()[0]!;
    const deadline = now().toISOString();
    f.db
      .update(canvasDocBatches)
      .set({ leaseUntil: deadline })
      .where(eq(canvasDocBatches.batchId, original.sourceId))
      .run();
    f.db.$client
      .exec(`CREATE TRIGGER refuse_doc_resume BEFORE UPDATE OF lease_until ON canvas_doc_batches
      WHEN NEW.error_code='document_resume_retry' BEGIN SELECT RAISE(ABORT, 'resume write refused'); END`);
    nudges = 0;
    const recovery = await pump.resumeAcceptedPage();
    expect(recovery).toMatchObject({ selected: 1, retryableFailures: 1 });
    expect(recovery.notifications.size).toBe(0);
    expect(recovery.nextEligibleAt).toBe(new Date(time + 60000).toISOString());
    expect(nudges).toBe(0);
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([original]);
    expect(f.store.getBatch(original.sourceId)).toMatchObject({
      status: 'accepted',
      leaseUntil: deadline,
      generation: original.sourceGeneration,
      admissionReceiptId: original.id,
    });
    expect(f.db.select().from(sessionMessageQueue).all()[0]?.id).toBe(original.queueMessageId);
  });
  it('preserves accepted work when a second file connection locks source preparation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-pump-locked-'));
    directories.push(dir);
    const file = join(dir, 'state.db');
    let time = Date.parse(NOW);
    const now = () => new Date(time);
    const f = batchFixture(file, null, undefined, 'boot-1', 'claude-code', now);
    databases.push(f.db);
    f.db.$client.pragma('busy_timeout = 0');
    f.db.$client.pragma('journal_mode = DELETE');
    const locker = new Database(file);
    nativeConnections.push(locker);
    locker.pragma('busy_timeout = 0');
    let nudges = 0;
    const pump = new DocBatchDeliveryPump(
      options(f, now, () => {
        nudges++;
        return undefined;
      })
    );
    f.input();
    time += 1001;
    expect(pump.run().admitted).toBe(1);
    const original = f.db.select().from(sessionMessageAcceptanceReceipts).all()[0]!;
    const batch = f.store.getBatch(original.sourceId);
    const queued = f.db.select().from(sessionMessageQueue).all();
    const prepare = f.admission.source.prepare.bind(f.admission.source);
    f.admission.source.prepare = (receipt) => {
      locker.exec('BEGIN EXCLUSIVE');
      try {
        return prepare(receipt);
      } finally {
        // Release before recovery catches the rejection: cancellation would otherwise succeed.
        locker.exec('ROLLBACK');
      }
    };
    nudges = 0;
    const classify = vi.spyOn(f.admission.acceptance, 'isPreclaimRefusal');
    const recovery = await pump.resumeAcceptedPage();
    expect(recovery).toMatchObject({ selected: 1, retryableFailures: 1 });
    expect(classify.mock.calls[0]?.[1]).toMatchObject({ code: 'SQLITE_BUSY' });
    expect(nudges).toBe(0);
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([original]);
    expect(f.store.getBatch(original.sourceId)).toEqual({
      ...batch,
      leaseUntil: new Date(time + 60000).toISOString(),
      errorCode: 'document_resume_retry',
      updatedAt: now().toISOString(),
    });
    expect(f.db.select().from(sessionMessageQueue).all()).toEqual(queued);
    f.admission.source.prepare = prepare;
    expect(await pump.resumeAccepted()).toBe(0);
    time += 60000;
    expect(await pump.resumeAccepted()).toBe(1);
    expect(nudges).toBe(1);
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([original]);
  });
  it('cancels accepted recovery after a proven current grant revocation', async () => {
    const f = batchFixture();
    databases.push(f.db);
    f.input();
    const accepted = f.admission.admit(f.batchId());
    f.grants.revoke(f.documentId, f.grantId, f.actor);
    let nudges = 0;
    const pump = new DocBatchDeliveryPump(
      options(
        f,
        () => new Date(NOW),
        () => {
          nudges++;
          return undefined;
        }
      )
    );
    expect(await pump.resumeAccepted()).toBe(0);
    expect(nudges).toBe(0);
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()[0]).toMatchObject({
      id: accepted.receipt.id,
      state: 'cancelled',
      cancellationCode: 'document_recovery_authority_refused',
    });
    expect(f.store.getBatch(accepted.receipt.sourceId)?.status).toBe('cancelled');
    expect(f.db.select().from(sessionMessageQueue).all()).toEqual([]);
  });
  it.each(['claimed', 'started'] as const)(
    'quarantines a previous-boot %s receipt instead of resuming uncertain effects',
    async (state) => {
      const f = batchFixture();
      databases.push(f.db);
      f.input();
      const accepted = f.admission.admit(f.batchId());
      const prepared = await f.admission.acceptance.prepare(accepted.receipt.id);
      f.admission.acceptance.claim(accepted.receipt.id, prepared);
      if (state === 'started') f.admission.acceptance.markTurnStarted(accepted.receipt.id, 5);
      const reboot = batchFixture(
        ':memory:',
        null,
        { db: f.db, documentId: f.documentId, grantId: f.grantId },
        'boot-2'
      );
      const nudges: string[] = [];
      const pump = new DocBatchDeliveryPump(
        options(
          reboot,
          () => new Date(NOW),
          (id) => {
            nudges.push(id);
            return undefined;
          }
        )
      );
      expect(await pump.resumeAccepted()).toBe(0);
      expect(pump.run().admitted).toBe(0);
      expect(nudges).toEqual([]);
      expect(reboot.store.getBatch(accepted.receipt.sourceId)?.status).toBe('in_doubt');
      expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()[0]).toMatchObject({
        id: accepted.receipt.id,
        state: 'outcome_unknown',
      });
    }
  );
  it('continues oldest-due scheduling across documents when one target budget waits', () => {
    let time = Date.parse(NOW);
    const now = () => new Date(time);
    const f = batchFixture(':memory:', null, undefined, 'boot-1', 'claude-code', now);
    databases.push(f.db);
    f.input();
    time += 1001;
    const second = f.canvas.open(FROM, 'agent-1', {
      type: 'markdown',
      title: 'Second',
      content: 'Other private body',
    }).id;
    f.db
      .update(canvasDocChannels)
      .set({ openerAgentId: 'agent-1' })
      .where(eq(canvasDocChannels.documentId, second))
      .run();
    f.grants.configure(
      second,
      f.store.getChannel(f.documentId)!.declaration as CanvasChannelDeclaration,
      f.actor
    );
    const granted = f.grants.grant(
      { documentId: second, routeId: 'route', expiresAt: '2026-10-02T00:00:00.000Z' },
      f.actor
    );
    expect(granted.kind).toBe('granted');
    const ingest = new DocChannelIngest(f.store, now);
    ingest.accept(
      { v: 1, id: randomUUID(), type: 'task.toggle', payload: { checked: true } },
      (tx) => ({
        documentId: second,
        scope: FROM,
        documentLabel: 'Second',
        provenance: { trust: 'app_untrusted' },
        routes: f.grants.getCurrentRoutes(second, 'task.toggle', f.actor, tx),
      })
    );
    time += 1001;
    const order: string[] = [];
    const configuration = options(f, now, () => undefined);
    configuration.budget = (batch) => {
      order.push(batch.documentId);
      return batch.documentId === f.documentId
        ? {
            available: false,
            reason: 'platform_budget',
            nextEligibleAt: new Date(time + 60000).toISOString(),
          }
        : { available: true };
    };
    expect(new DocBatchDeliveryPump(configuration).run()).toMatchObject({
      waiting: 1,
      admitted: 1,
    });
    expect(order).toEqual([f.documentId, second]);
  });
});
