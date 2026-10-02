/** File SQLite restart through the actual document source, coordinator and dispatcher. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDb,
  sql,
  eq,
  canvasDocChannels,
  sessionMessageAcceptanceReceipts,
  sessionMessageQueue,
  type Db,
} from '@dorkos/db';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(await resumed.resumeAccepted()).toBe(1);
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
