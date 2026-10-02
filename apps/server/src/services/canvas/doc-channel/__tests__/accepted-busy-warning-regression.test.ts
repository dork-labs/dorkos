/** Real dispatcher busy-wait warning evidence with unchanged durable dispatch identity. */
import { it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sessionMessageAcceptanceReceipts } from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { batchFixture, NOW } from './batch-fixtures.js';
import { DocBatchDeliveryPump } from '../delivery/pump.js';
import {
  adoptAcceptedPrivateMessages,
  noteRuntimeTurnOpen,
  noteRuntimeTurnClosed,
  resetMessageDispatcher,
} from '../../../session/message-dispatcher.js';
import { setPrivateSessionMessageAcceptanceService } from '../../../session/private-messages/acceptance.js';
import {
  StagedContextStore,
  setStagedContextStore,
} from '../../../session/staged-context-store.js';
import { setMessageQueueStore } from '../../../session/message-queue-store.js';
import {
  getOrCreateProjector,
  disposeProjector,
} from '../../../session/session-state-projector.js';
it('warns accepted input held behind a busy actual dispatcher without claiming or repeating it', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const dir = mkdtempSync(join(tmpdir(), 'accepted-busy-warning-'));
  const f = batchFixture(
    join(dir, 'state.db'),
    null,
    undefined,
    'boot-1',
    'claude-code',
    () => new Date()
  );
  const runtime = new FakeAgentRuntime('claude-code');
  runtime.getInternalSessionId.mockReturnValue(undefined);
  runtime.withScenarios([
    async function* () {
      yield { type: 'done' as const, data: {} };
    },
  ]);
  setMessageQueueStore(f.queue);
  setPrivateSessionMessageAcceptanceService(f.admission.acceptance);
  try {
    f.input();
    const accepted = f.admission.admit(f.batchId());
    const stagedStore = new StagedContextStore(f.db);
    setStagedContextStore(stagedStore);
    stagedStore.hold('session-1', 'Keep this busy-wait note', 'busy-warning-note');
    noteRuntimeTurnOpen('session-1');
    const adopt = () => {
      adoptAcceptedPrivateMessages({
        sessionId: 'session-1',
        runtime,
        projector: getOrCreateProjector('session-1'),
        privateReceiptSelection: {
          sourceKind: 'document_event_batch',
          receiptIds: [accepted.receipt.id],
        },
      });
      return undefined;
    };
    adopt();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    const pump = new DocBatchDeliveryPump({
      db: f.db,
      store: f.store,
      grants: f.grants,
      admission: f.admission,
      now: () => new Date(),
      capacity: () => ({ available: true }),
      budget: () => ({ available: true }),
      markWaitingWarning: (id, g, at, tx) => f.store.markWaitingWarning(id, g, at, tx),
      nudge: adopt,
    });
    const evidence = () => {
      const { waitingWarningAt: _marker, ...batch } = f.store.getBatch(accepted.receipt.sourceId)!;
      return {
        batch,
        receipts: f.db.$client
          .prepare('SELECT * FROM session_message_acceptance_receipts ORDER BY id')
          .all(),
        queue: f.db.$client.prepare('SELECT * FROM session_message_queue ORDER BY id').all(),
        staged: f.db.$client.prepare('SELECT * FROM session_staged_context ORDER BY id').all(),
        deliveries: f.store.listDeliveries(f.documentId, batch.inputEventIds[0]!),
        inputs: f.db.$client
          .prepare("SELECT * FROM canvas_doc_events WHERE direction='upstream' ORDER BY doc_seq")
          .all(),
      };
    };
    const before = evidence();
    expect(before.staged).toHaveLength(1);
    vi.setSystemTime(new Date(Date.parse(NOW) + 15 * 60000 - 1));
    await pump.inspectAcceptedWaitWarnings();
    pump.run();
    expect(f.store.getBatch(accepted.receipt.sourceId)!.waitingWarningAt).toBeNull();
    expect(evidence()).toEqual(before);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(Date.parse(NOW) + 15 * 60000));
    await pump.inspectAcceptedWaitWarnings();
    pump.run();
    expect(evidence()).toEqual(before);

    const row = f.store.getBatch(accepted.receipt.sourceId)!;
    const count = f.db.$client
      .prepare(
        "SELECT count(*) AS n FROM canvas_doc_events WHERE type='event.status' AND json_extract(payload,'$.warning') IS NOT NULL"
      )
      .get() as { n: number };
    console.log(
      JSON.stringify({
        elapsedMinutes: 15,
        batchStatus: row.status,
        deliveryStatus: f.store.listDeliveries(f.documentId, row.inputEventIds[0]!)[0]?.status,
        waitingWarningAt: row.waitingWarningAt,
        warnings: count.n,
        busyDispatchCalls: runtime.sendMessage.mock.calls.length,
      })
    );
    expect(row.status).toBe('accepted');
    expect(f.queue.get(accepted.receipt.queueMessageId)).toBeDefined();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect.soft(count.n).toBe(1);
    expect.soft(row.waitingWarningAt).toBe(new Date(Date.parse(NOW) + 15 * 60000).toISOString());
    await pump.inspectAcceptedWaitWarnings();
    pump.run();
    expect(
      f.db.$client
        .prepare(
          "SELECT count(*) AS n FROM canvas_doc_events WHERE type='event.status' AND json_extract(payload,'$.warning') IS NOT NULL"
        )
        .get()
    ).toEqual({ n: 1 });
    expect(evidence()).toEqual(before);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    // Ordinary recovery may refresh its observation timestamp; warnings themselves
    // preserve every dispatch field and never nudge the busy dispatcher.
    await pump.resumeAcceptedPage();
    pump.run();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    noteRuntimeTurnClosed('session-1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    const settled = f.db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
      .get()!;
    expect(settled).toMatchObject({
      id: accepted.receipt.id,
      sourceId: accepted.receipt.sourceId,
      sourceGeneration: accepted.receipt.sourceGeneration,
      queueMessageId: accepted.receipt.queueMessageId,
    });
    expect(settled.turnStartedAt).not.toBeNull();
    expect(f.store.getBatch(accepted.receipt.sourceId)?.generation).toBe(
      accepted.receipt.sourceGeneration
    );
    expect(f.db.$client.prepare('SELECT * FROM session_staged_context').all()).toEqual([]);
    expect(JSON.stringify(runtime.sendMessage.mock.calls)).toContain('Keep this busy-wait note');
  } finally {
    resetMessageDispatcher();
    disposeProjector('session-1');
    setMessageQueueStore(undefined);
    setStagedContextStore(undefined);
    setPrivateSessionMessageAcceptanceService(undefined);
    vi.useRealTimers();
    f.db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
