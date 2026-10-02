/** Real durable recovery holds must not become permanent protected-source refusals. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canvasDocIdentityIntents,
  canvasDocuments,
  createDb,
  eq,
  sessionMessageAcceptanceReceipts,
  sessionMessageQueue,
  sessionStagedContext,
  type Db,
} from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import { batchFixture, NOW, type BatchFixture } from './batch-fixtures.js';
import { DocChannelAuthorization, DocChannelNotFoundError } from '../authorization.js';
import { DocChannelIdentityBlockedError } from '../lifecycle.js';
import { DocRouteGrantError } from '../grant-policy.js';
import { DocBatchDeliveryPump } from '../delivery/pump.js';
import {
  PrivateSessionMessageRefusalError,
  setPrivateSessionMessageAcceptanceService,
} from '../../../session/private-messages/acceptance.js';
import { setMessageQueueStore } from '../../../session/message-queue-store.js';
import {
  adoptAcceptedPrivateMessages,
  noteRuntimeTurnOpen,
  noteRuntimeTurnClosed,
  resetMessageDispatcher,
} from '../../../session/message-dispatcher.js';
import {
  disposeProjector,
  getOrCreateProjector,
} from '../../../session/session-state-projector.js';
import {
  StagedContextStore,
  holdStagedContext,
  setStagedContextStore,
  resetStagedContextStore,
} from '../../../session/staged-context-store.js';

const databases: Db[] = [];
const directories: string[] = [];
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 50));
}
afterEach(async () => {
  await settle();
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  setPrivateSessionMessageAcceptanceService(undefined);
  setStagedContextStore(undefined);
  resetStagedContextStore();
  disposeProjector('session-1');
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) if (db.$client.open) db.$client.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function pump(f: BatchFixture, nudge: (id: string) => undefined, now = () => new Date(NOW)) {
  return new DocBatchDeliveryPump({
    db: f.db,
    store: f.store,
    grants: f.grants,
    admission: f.admission,
    now,
    capacity: () => ({ available: true }),
    budget: () => ({ available: true }),
    markWaitingWarning: () => false,
    nudge,
  });
}

describe('accepted pump source-aware recovery refusal', () => {
  it.each(['pending', 'in_doubt', 'failed'] as const)(
    'retains accepted work under a real %s identity hold and resumes exactly once after recovery',
    async (status) => {
      const directory = mkdtempSync(join(tmpdir(), 'doc-recovery-hold-'));
      directories.push(directory);
      const f = batchFixture(join(directory, 'state.db'));
      databases.push(f.db);
      f.input();
      const accepted = f.admission.admit(f.batchId());
      const authorization = new DocChannelAuthorization(f.db, f.documents, {
        ownsInstallation: (claims) =>
          claims.owner.kind === 'local_install' && claims.owner.installationId === 'installation',
        principalCurrent: (proof) => proof === f.actor.principal,
        roomMembership: () => undefined,
      });
      f.authority.requireGrantedCurrent = (grant, tx) =>
        authorization.requireCurrent(grant.documentId, f.actor, true, tx);
      await expect(f.admission.acceptance.prepare(accepted.receipt.id)).resolves.toMatchObject({
        sourceId: accepted.receipt.sourceId,
      });
      setStagedContextStore(new StagedContextStore(f.db));
      holdStagedContext('session-1', 'Retain this recovery note', 'recovery-note');
      const receiptBefore = f.db.select().from(sessionMessageAcceptanceReceipts).all();
      const queuedBefore = f.db.select().from(sessionMessageQueue).all();
      const stagedBefore = f.db.select().from(sessionStagedContext).all();
      const batchBefore = f.store.getBatch(accepted.receipt.sourceId);
      const inputBefore = batchBefore!.inputEventIds.map((id) =>
        f.store.getEvent(f.documentId, id)
      );
      expect(inputBefore.every((event) => event !== undefined)).toBe(true);
      f.db
        .insert(canvasDocIdentityIntents)
        .values({
          intentId: 'recovery-hold',
          documentId: f.documentId,
          fromScope: 'session:session-1',
          toScope: 'session:canonical',
          sourceId: accepted.receipt.sourceId,
          sourceGeneration: accepted.receipt.sourceGeneration,
          evidence: {},
          status,
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();
      await expect(f.admission.acceptance.prepare(accepted.receipt.id)).rejects.toBeInstanceOf(
        DocChannelNotFoundError
      );
      let nudges = 0;
      const runtime = new FakeAgentRuntime('claude-code');
      runtime.getInternalSessionId.mockReturnValue(undefined);
      runtime.withScenarios([
        async function* (): AsyncGenerator<StreamEvent> {
          yield { type: 'done', data: {} };
        },
      ]);
      const wake = (id: string) => {
        nudges++;
        adoptAcceptedPrivateMessages({
          sessionId: id,
          projector: getOrCreateProjector(id),
          runtime,
        });
        return undefined;
      };
      let time = Date.parse(NOW);
      const now = () => new Date(time);
      const first = pump(f, wake, now);
      const classify = vi.spyOn(f.admission.acceptance, 'isPreclaimRefusal');
      const page = await first.resumeAcceptedPage();
      expect(page).toMatchObject({ selected: 1, retryableFailures: 1, hasMore: false });
      const refusal = classify.mock.calls[0]?.[1];
      expect(nudges).toBe(0);
      expect(runtime.sendMessage).not.toHaveBeenCalled();
      expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual(receiptBefore);
      expect(refusal).toBeInstanceOf(DocChannelNotFoundError);
      expect(f.db.select().from(sessionMessageQueue).all()).toEqual(queuedBefore);
      expect(f.db.select().from(sessionStagedContext).all()).toEqual(stagedBefore);
      expect(f.store.getBatch(accepted.receipt.sourceId)).toEqual({
        ...batchBefore,
        leaseUntil: new Date(time + 60000).toISOString(),
        errorCode: 'document_resume_retry',
        updatedAt: now().toISOString(),
      });
      expect(batchBefore!.inputEventIds.map((id) => f.store.getEvent(f.documentId, id))).toEqual(
        inputBefore
      );
      // Recovery abandons the uncommitted move; no canonical alias or wider authority is installed.
      f.db
        .delete(canvasDocIdentityIntents)
        .where(eq(canvasDocIdentityIntents.intentId, 'recovery-hold'))
        .run();
      setMessageQueueStore(f.queue);
      setPrivateSessionMessageAcceptanceService(f.admission.acceptance);
      noteRuntimeTurnOpen('session-1');
      expect(await first.resumeAccepted()).toBe(0);
      time += 60000;
      const resumed = await Promise.all([
        first.resumeAccepted(),
        pump(f, wake, now).resumeAccepted(),
      ]);
      expect(resumed.sort()).toEqual([0, 1]);
      expect(nudges).toBe(1);
      expect(await first.resumeAccepted()).toBe(0);
      await settle();
      expect(runtime.sendMessage).not.toHaveBeenCalled();
      expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual(receiptBefore);
      expect(f.db.select().from(sessionStagedContext).all()).toEqual(stagedBefore);
      noteRuntimeTurnClosed('session-1');
      await settle();
      expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
      expect(runtime.sendMessage.mock.calls[0]?.[2]?.additionalContext).toEqual(
        expect.arrayContaining([
          {
            kind: 'staged_context',
            scope: 'per-turn',
            data: { text: 'Retain this recovery note' },
          },
        ])
      );
      expect(f.db.select().from(sessionMessageAcceptanceReceipts).get()).toMatchObject({
        id: accepted.receipt.id,
        sourceId: accepted.receipt.sourceId,
        sourceGeneration: accepted.receipt.sourceGeneration,
        queueMessageId: accepted.receipt.queueMessageId,
        state: 'settled',
        settleOutcome: 'completed',
      });
      expect(f.db.select().from(sessionMessageQueue).all()).toEqual([]);
      expect(f.db.select().from(sessionStagedContext).all()).toEqual([]);
      expect(await first.resumeAccepted()).toBe(0);
      expect(nudges).toBe(1);
    }
  );
  it.each([
    new Error('Temporary source failure'),
    new PrivateSessionMessageRefusalError('source_adapter_unavailable', 'Unavailable'),
    new PrivateSessionMessageRefusalError('dispatch_claim_raced', 'Another claimant'),
    new DocRouteGrantError('AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY'),
    new DocRouteGrantError('TEMPORARILY_UNAVAILABLE', 503),
  ])('preserves accepted recovery for non-authority failure %s', async (failure) => {
    const f = batchFixture();
    databases.push(f.db);
    f.input();
    const accepted = f.admission.admit(f.batchId());
    const before = f.db.select().from(sessionMessageAcceptanceReceipts).all();
    const batch = f.store.getBatch(accepted.receipt.sourceId);
    const queued = f.db.select().from(sessionMessageQueue).all();
    vi.spyOn(f.admission.source, 'prepare').mockRejectedValueOnce(failure);
    let nudges = 0;
    let time = Date.parse(NOW);
    const now = () => new Date(time);
    const classify = vi.spyOn(f.admission.acceptance, 'isPreclaimRefusal');
    const recovery = pump(
      f,
      () => {
        nudges++;
        return undefined;
      },
      now
    );
    const page = await recovery.resumeAcceptedPage();
    expect(page).toMatchObject({ selected: 1, retryableFailures: 1, hasMore: false });
    expect(classify).toHaveBeenCalledWith(accepted.receipt.id, failure);
    expect(nudges).toBe(0);
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual(before);
    expect(f.db.select().from(sessionMessageQueue).all()).toEqual(queued);
    expect(f.store.getBatch(accepted.receipt.sourceId)).toEqual({
      ...batch,
      leaseUntil: new Date(time + 60000).toISOString(),
      errorCode: 'document_resume_retry',
      updatedAt: now().toISOString(),
    });
    expect(await recovery.resumeAccepted()).toBe(0);
    time += 60000;
    expect(await recovery.resumeAccepted()).toBe(1);
    expect(await recovery.resumeAccepted()).toBe(0);
    expect(nudges).toBe(1);
  });
});

it.each(['pending', 'in_doubt', 'failed'] as const)(
  'preserves a stale %s hold refusal after another SQLite connection releases it before pump classification',
  async (status) => {
    const directory = mkdtempSync(join(tmpdir(), 'doc-pump-hold-release-'));
    directories.push(directory);
    const file = join(directory, 'state.db');
    const f = batchFixture(file);
    databases.push(f.db);
    const recovery = createDb(file);
    databases.push(recovery);
    f.input();
    const accepted = f.admission.admit(f.batchId());
    const authorization = new DocChannelAuthorization(f.db, f.documents, {
      ownsInstallation: (claims) =>
        claims.owner.kind === 'local_install' && claims.owner.installationId === 'installation',
      principalCurrent: (proof) => proof === f.actor.principal,
      roomMembership: () => undefined,
    });
    f.authority.requireGrantedCurrent = (grant, tx) =>
      authorization.requireCurrent(grant.documentId, f.actor, true, tx);
    const prepare = f.admission.source.prepare.bind(f.admission.source);
    await expect(prepare(accepted.receipt)).resolves.toMatchObject({
      sourceId: accepted.receipt.sourceId,
    });
    f.db
      .insert(canvasDocIdentityIntents)
      .values({
        intentId: 'hold',
        documentId: f.documentId,
        fromScope: 'session:session-1',
        toScope: 'session:canonical',
        sourceId: accepted.receipt.sourceId,
        sourceGeneration: accepted.receipt.sourceGeneration,
        evidence: {},
        status,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    setStagedContextStore(new StagedContextStore(f.db));
    holdStagedContext('session-1', 'Preserve the pump recovery note', 'pump-race-note');
    const receipts = f.db.select().from(sessionMessageAcceptanceReceipts).all();
    const queued = f.db.select().from(sessionMessageQueue).all();
    const staged = f.db.select().from(sessionStagedContext).all();
    const batch = f.store.getBatch(accepted.receipt.sourceId)!;
    const inputs = batch.inputEventIds.map((id) => f.store.getEvent(f.documentId, id));
    expect(inputs.every((event) => event !== undefined)).toBe(true);
    let refusal: unknown;
    vi.spyOn(f.admission.source, 'prepare').mockImplementationOnce(async (receipt) => {
      try {
        return await prepare(receipt);
      } catch (error) {
        refusal = error;
        recovery
          .delete(canvasDocIdentityIntents)
          .where(eq(canvasDocIdentityIntents.intentId, 'hold'))
          .run();
        expect(await prepare(receipt)).toMatchObject({
          sourceId: receipt.sourceId,
          sourceGeneration: receipt.sourceGeneration,
        });
        throw error;
      }
    });
    const runtime = new FakeAgentRuntime('claude-code');
    runtime.getInternalSessionId.mockReturnValue(undefined);
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} };
      },
    ]);
    let nudges = 0;
    const wake = (id: string): undefined => {
      nudges++;
      adoptAcceptedPrivateMessages({ sessionId: id, projector: getOrCreateProjector(id), runtime });
      return undefined;
    };
    let time = Date.parse(NOW);
    const now = () => new Date(time);
    const delivery = pump(f, wake, now);
    const classify = vi.spyOn(f.admission.acceptance, 'isPreclaimRefusal');
    const page = await delivery.resumeAcceptedPage();
    expect(page).toMatchObject({ selected: 1, retryableFailures: 1, hasMore: false });
    const failed = classify.mock.calls[0]?.[1];
    expect(failed).toBeInstanceOf(DocChannelNotFoundError);
    expect(failed).toBe(refusal);
    expect(failed).toMatchObject({ cause: expect.any(DocChannelIdentityBlockedError) });
    expect(f.admission.acceptance.isPreclaimRefusal(accepted.receipt.id, refusal)).toBe(false);
    expect(f.db.select().from(canvasDocIdentityIntents).all()).toEqual([]);
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual(receipts);
    expect(f.db.select().from(sessionMessageQueue).all()).toEqual(queued);
    expect(f.db.select().from(sessionStagedContext).all()).toEqual(staged);
    expect(f.store.getBatch(accepted.receipt.sourceId)).toEqual({
      ...batch,
      leaseUntil: new Date(time + 60000).toISOString(),
      errorCode: 'document_resume_retry',
      updatedAt: now().toISOString(),
    });
    expect(batch.inputEventIds.map((id) => f.store.getEvent(f.documentId, id))).toEqual(inputs);
    expect(nudges).toBe(0);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    setMessageQueueStore(f.queue);
    setPrivateSessionMessageAcceptanceService(f.admission.acceptance);
    noteRuntimeTurnOpen('session-1');
    expect(await delivery.resumeAccepted()).toBe(0);
    time += 60000;
    expect(
      (await Promise.all([delivery.resumeAccepted(), pump(f, wake, now).resumeAccepted()])).sort()
    ).toEqual([0, 1]);
    expect(nudges).toBe(1);
    await settle();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual(receipts);
    expect(f.db.select().from(sessionStagedContext).all()).toEqual(staged);
    noteRuntimeTurnClosed('session-1');
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    const context = runtime.sendMessage.mock.calls[0]?.[2]?.additionalContext ?? [];
    expect(context.filter((item) => item.kind === 'staged_context')).toEqual([
      {
        kind: 'staged_context',
        scope: 'per-turn',
        data: { text: 'Preserve the pump recovery note' },
      },
    ]);
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).get()).toMatchObject({
      id: accepted.receipt.id,
      sourceId: accepted.receipt.sourceId,
      sourceGeneration: accepted.receipt.sourceGeneration,
      queueMessageId: accepted.receipt.queueMessageId,
      originAuthorityDigest: accepted.receipt.originAuthorityDigest,
      state: 'settled',
      settleOutcome: 'completed',
    });
    expect(f.db.select().from(sessionMessageQueue).all()).toEqual([]);
    expect(f.db.select().from(sessionStagedContext).all()).toEqual([]);
    expect(await delivery.resumeAccepted()).toBe(0);
    expect(nudges).toBe(1);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  }
);

it.each(['delete', 'close', 'revoke'] as const)(
  'pump still cancels actual %s authority loss',
  async (loss) => {
    const f = batchFixture();
    databases.push(f.db);
    f.input();
    const accepted = f.admission.admit(f.batchId());
    const authorization = new DocChannelAuthorization(f.db, f.documents, {
      ownsInstallation: (claims) =>
        claims.owner.kind === 'local_install' && claims.owner.installationId === 'installation',
      principalCurrent: (proof) => proof === f.actor.principal,
      roomMembership: () => undefined,
    });
    f.authority.requireGrantedCurrent = (grant, tx) =>
      authorization.requireCurrent(grant.documentId, f.actor, true, tx);
    await expect(f.admission.source.prepare(accepted.receipt)).resolves.toMatchObject({
      sourceId: accepted.receipt.sourceId,
    });
    if (loss === 'delete')
      f.db.delete(canvasDocuments).where(eq(canvasDocuments.id, f.documentId)).run();
    else if (loss === 'close') f.canvas.close('session:session-1', f.documentId);
    else f.grants.revoke(f.documentId, f.grantId, f.actor);
    let nudges = 0;
    expect(
      await pump(f, () => {
        nudges++;
        return undefined;
      }).resumeAccepted()
    ).toBe(0);
    expect(nudges).toBe(0);
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).get()).toMatchObject({
      id: accepted.receipt.id,
      state: 'cancelled',
    });
    expect(f.queue.get(accepted.receipt.queueMessageId)).toBeUndefined();
    expect(f.store.getBatch(accepted.receipt.sourceId)?.status).toBe('cancelled');
  }
);
