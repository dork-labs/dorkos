/** Actual protected source claims retain durable work until a runtime effect is claimed. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createDb,
  canvasDocuments,
  canvasDocIdentityIntents,
  eq,
  sessionMessageAcceptanceReceipts,
  sessionMessageQueue,
  sessionStagedContext,
  type Db,
} from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import { batchFixture, FROM, NOW } from '../../canvas/doc-channel/__tests__/batch-fixtures.js';
import {
  DocChannelAuthorization,
  DocChannelNotFoundError,
} from '../../canvas/doc-channel/authorization.js';
import { DocChannelIdentityBlockedError } from '../../canvas/doc-channel/lifecycle.js';
import { DocRouteGrantError } from '../../canvas/doc-channel/grant-policy.js';
import { PrivateSessionMessageRefusalError } from '../private-messages/refusal.js';
import {
  adoptAcceptedPrivateMessages,
  noteTurnBoundary,
  resetMessageDispatcher,
} from '../message-dispatcher.js';
import { setPrivateSessionMessageAcceptanceService } from '../private-messages/acceptance.js';
import { setMessageQueueStore } from '../message-queue-store.js';
import { disposeProjector, getOrCreateProjector } from '../session-state-projector.js';
import {
  StagedContextStore,
  holdStagedContext,
  setStagedContextStore,
  resetStagedContextStore,
} from '../staged-context-store.js';
const databases: Db[] = [];
const directories: string[] = [];
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 50));
}
afterEach(async () => {
  await settle();
  resetMessageDispatcher();
  setPrivateSessionMessageAcceptanceService(undefined);
  setMessageQueueStore(undefined);
  setStagedContextStore(undefined);
  resetStagedContextStore();
  disposeProjector('session-1');
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) if (db.$client.open) db.$client.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
it('retains accepted work and staged notes after a real locked final claim, then retries exactly once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'doc-primary-preclaim-'));
  directories.push(directory);
  const file = join(directory, 'state.db');
  const f = batchFixture(file);
  databases.push(f.db);
  f.db.$client.pragma('busy_timeout=0');
  f.input();
  const accepted = f.admission.admit(f.batchId());
  const locker = createDb(file);
  databases.push(locker);
  locker.$client.pragma('busy_timeout=0');
  setStagedContextStore(new StagedContextStore(f.db));
  holdStagedContext('session-1', 'Preserve this note through claim failure', 'preclaim-note');
  const receiptBefore = f.db.select().from(sessionMessageAcceptanceReceipts).all();
  const queueBefore = f.db.select().from(sessionMessageQueue).all();
  const stagedBefore = f.db.select().from(sessionStagedContext).all();
  const batchBefore = f.store.getBatch(accepted.receipt.sourceId)!;
  const inputsBefore = batchBefore.inputEventIds.map((id) => f.store.getEvent(f.documentId, id));
  expect(inputsBefore.every((event) => event !== undefined)).toBe(true);
  const original = f.admission.acceptance.claim.bind(f.admission.acceptance);
  let blocked = true;
  let failure: unknown;
  vi.spyOn(f.admission.acceptance, 'claim').mockImplementation((...args) => {
    if (blocked) locker.$client.exec('BEGIN IMMEDIATE');
    try {
      return original(...args);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (locker.$client.inTransaction) locker.$client.exec('ROLLBACK');
    }
  });
  const runtime = new FakeAgentRuntime('claude-code');
  runtime.getInternalSessionId.mockReturnValue(undefined);
  runtime.withScenarios([
    async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'done', data: {} };
    },
  ]);
  setMessageQueueStore(f.queue);
  setPrivateSessionMessageAcceptanceService(f.admission.acceptance);
  const options = { sessionId: 'session-1', projector: getOrCreateProjector('session-1'), runtime };
  adoptAcceptedPrivateMessages(options);
  await settle();
  expect(failure).toMatchObject({ code: 'SQLITE_BUSY' });
  expect(runtime.sendMessage).not.toHaveBeenCalled();
  expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual(receiptBefore);
  expect(f.db.select().from(sessionMessageQueue).all()).toEqual(queueBefore);
  expect(f.db.select().from(sessionStagedContext).all()).toEqual(stagedBefore);
  expect(f.store.getBatch(accepted.receipt.sourceId)).toEqual(batchBefore);
  expect(batchBefore.inputEventIds.map((id) => f.store.getEvent(f.documentId, id))).toEqual(
    inputsBefore
  );
  expect(runtime.releaseLock).toHaveBeenCalled();
  blocked = false;
  noteTurnBoundary('session-1');
  await settle();
  expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  expect(runtime.sendMessage.mock.calls[0]?.[2]?.additionalContext).toEqual(
    expect.arrayContaining([
      {
        kind: 'staged_context',
        scope: 'per-turn',
        data: { text: 'Preserve this note through claim failure' },
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
  noteTurnBoundary('session-1');
  await settle();
  expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
});

it.each(['pending', 'in_doubt', 'failed'] as const)(
  'retains the original %s recovery refusal after another connection releases the hold',
  async (status) => {
    const directory = mkdtempSync(join(tmpdir(), 'doc-primary-hold-race-'));
    directories.push(directory);
    const file = join(directory, 'state.db');
    const f = batchFixture(file);
    databases.push(f.db);
    f.input();
    const accepted = f.admission.admit(f.batchId());
    const recovery = createDb(file);
    databases.push(recovery);
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
        fromScope: FROM,
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
    holdStagedContext('session-1', 'Preserve recovery note', 'race-note');
    const before = f.db.select().from(sessionMessageAcceptanceReceipts).all();
    const queued = f.db.select().from(sessionMessageQueue).all();
    const staged = f.db.select().from(sessionStagedContext).all();
    const batch = f.store.getBatch(accepted.receipt.sourceId);
    let refusal: unknown;
    vi.spyOn(f.admission.source, 'prepare').mockImplementationOnce(async (receipt) => {
      try {
        return await prepare(receipt);
      } catch (error) {
        refusal = error;
        // Recover the abandoned move on another real connection before the dispatcher sees the old response.
        recovery
          .delete(canvasDocIdentityIntents)
          .where(eq(canvasDocIdentityIntents.intentId, 'hold'))
          .run();
        expect((await prepare(receipt)).sourceId).toBe(receipt.sourceId);
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
    setMessageQueueStore(f.queue);
    setPrivateSessionMessageAcceptanceService(f.admission.acceptance);
    adoptAcceptedPrivateMessages({
      sessionId: 'session-1',
      projector: getOrCreateProjector('session-1'),
      runtime,
    });
    await settle();
    expect(refusal).toBeInstanceOf(DocChannelNotFoundError);
    expect(refusal).toMatchObject({ cause: expect.any(DocChannelIdentityBlockedError) });
    expect(f.admission.acceptance.isPreclaimRefusal(accepted.receipt.id, refusal)).toBe(false);
    expect(f.db.select().from(canvasDocIdentityIntents).all()).toEqual([]);
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual(before);
    expect(f.db.select().from(sessionMessageQueue).all()).toEqual(queued);
    expect(f.db.select().from(sessionStagedContext).all()).toEqual(staged);
    expect(f.store.getBatch(accepted.receipt.sourceId)).toEqual(batch);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    noteTurnBoundary('session-1');
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.sendMessage.mock.calls[0]?.[2]?.additionalContext).toEqual(
      expect.arrayContaining([
        { kind: 'staged_context', scope: 'per-turn', data: { text: 'Preserve recovery note' } },
      ])
    );
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).get()).toMatchObject({
      id: accepted.receipt.id,
      state: 'settled',
    });
    noteTurnBoundary('session-1');
    await settle();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  }
);

it.each(['delete', 'close', 'revoke'] as const)(
  'still cancels accepted work on genuine %s authority loss',
  async (cause) => {
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
    if (cause === 'delete')
      f.db.delete(canvasDocuments).where(eq(canvasDocuments.id, f.documentId)).run();
    else if (cause === 'close') f.canvas.close(FROM, f.documentId);
    else f.grants.revoke(f.documentId, f.grantId, f.actor);
    const runtime = new FakeAgentRuntime('claude-code');
    runtime.getInternalSessionId.mockReturnValue(undefined);
    setMessageQueueStore(f.queue);
    setPrivateSessionMessageAcceptanceService(f.admission.acceptance);
    adoptAcceptedPrivateMessages({
      sessionId: 'session-1',
      projector: getOrCreateProjector('session-1'),
      runtime,
    });
    await settle();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).get()).toMatchObject({
      id: accepted.receipt.id,
      state: 'cancelled',
    });
    expect(f.queue.get(accepted.receipt.queueMessageId)).toBeUndefined();
    expect(f.store.getBatch(accepted.receipt.sourceId)?.status).toBe('cancelled');
  }
);

it.each([
  new Error('Source temporarily unavailable'),
  new PrivateSessionMessageRefusalError('source_adapter_unavailable', 'Unavailable'),
  new PrivateSessionMessageRefusalError('receipt_not_accepted', 'Another claim'),
  new PrivateSessionMessageRefusalError('dispatch_claim_raced', 'Another claimant'),
  new PrivateSessionMessageRefusalError('document_identity_blocked', 'Recovery pending'),
  new DocRouteGrantError('AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY'),
  new DocRouteGrantError('TEMPORARILY_UNAVAILABLE', 503),
])('retains accepted input after non-authority preclaim failure %s', async (failure) => {
  const f = batchFixture();
  databases.push(f.db);
  f.input();
  const accepted = f.admission.admit(f.batchId());
  const before = f.db.select().from(sessionMessageAcceptanceReceipts).all();
  const queued = f.db.select().from(sessionMessageQueue).all();
  const batch = f.store.getBatch(accepted.receipt.sourceId);
  vi.spyOn(f.admission.source, 'prepare').mockRejectedValueOnce(failure);
  const runtime = new FakeAgentRuntime('claude-code');
  runtime.getInternalSessionId.mockReturnValue(undefined);
  runtime.withScenarios([
    async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'done', data: {} };
    },
  ]);
  setMessageQueueStore(f.queue);
  setPrivateSessionMessageAcceptanceService(f.admission.acceptance);
  adoptAcceptedPrivateMessages({
    sessionId: 'session-1',
    projector: getOrCreateProjector('session-1'),
    runtime,
  });
  await settle();
  expect(runtime.sendMessage).not.toHaveBeenCalled();
  expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual(before);
  expect(f.db.select().from(sessionMessageQueue).all()).toEqual(queued);
  expect(f.store.getBatch(accepted.receipt.sourceId)).toEqual(batch);
  noteTurnBoundary('session-1');
  await settle();
  expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
});
