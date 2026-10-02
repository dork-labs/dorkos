/** Durable document deadlines cross the actual coordinator, queue and runtime boundary. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canvasDocBatches,
  canvasDocIdentityIntents,
  createDb,
  eq,
  sessionMessageAcceptanceReceipts,
  type Db,
} from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  batchFixture,
  NOW,
  type BatchFixture,
} from '../../canvas/doc-channel/__tests__/batch-fixtures.js';
import {
  DOCUMENT_BUDGET_WAIT,
  type DocBeforeClaim,
} from '../../canvas/doc-channel/delivery/final-budget.js';
import {
  adoptAcceptedPrivateMessages,
  adoptQueuedMessages,
  cancelPendingDispatch,
  isTurnInFlight,
  noteRuntimeTurnClosed,
  noteRuntimeTurnOpen,
  noteTurnBoundary,
  resetMessageDispatcher,
} from '../message-dispatcher.js';
import { setPrivateSessionMessageAcceptanceService } from '../private-messages/acceptance.js';
import { PrivateSessionMessageRefusalError } from '../private-messages/refusal.js';
import { DocRouteGrantError } from '../../canvas/doc-channel/grant-policy.js';
import {
  DocChannelAuthorization,
  DocChannelNotFoundError,
} from '../../canvas/doc-channel/authorization.js';
import { setMessageQueueStore } from '../message-queue-store.js';
import { disposeProjector, getOrCreateProjector } from '../session-state-projector.js';
import {
  StagedContextStore,
  setStagedContextStore,
  holdStagedContext,
  resetStagedContextStore,
} from '../staged-context-store.js';

vi.mock('../context-assembler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../context-assembler.js')>()),
  assembleAdditionalContext: vi.fn(async () => []),
}));

const SESSION = 'session-1';
const databases: Db[] = [];
const directories: string[] = [];
const DEADLINE = new Date(Date.parse(NOW) + 10 * 60_000).toISOString();
const waitBudget: DocBeforeClaim = (_context, _tx, now) =>
  Date.parse(now) < Date.parse(DEADLINE)
    ? { decision: 'defer', reason: 'route_turn_ceiling', nextEligibleAt: DEADLINE }
    : { decision: 'admit' };

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

function install(f: BatchFixture) {
  const runtime = new FakeAgentRuntime('claude-code');
  runtime.getInternalSessionId.mockReturnValue(undefined);
  runtime.withScenarios(
    Array.from(
      { length: 3 },
      () =>
        async function* (): AsyncGenerator<StreamEvent> {
          yield { type: 'done', data: {} };
        }
    )
  );
  setMessageQueueStore(f.queue);
  setPrivateSessionMessageAcceptanceService(f.admission.acceptance);
  return {
    runtime,
    options: { sessionId: SESSION, projector: getOrCreateProjector(SESSION), runtime },
  };
}

function fixture(policy: DocBeforeClaim = waitBudget, file = ':memory:') {
  const f = batchFixture(file, null, undefined, 'boot-1', 'claude-code', () => new Date(), policy);
  databases.push(f.db);
  f.input();
  const accepted = f.admission.admit(f.batchId());
  return { f, accepted, ...install(f) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.restoreAllMocks();
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  setPrivateSessionMessageAcceptanceService(undefined);
  setStagedContextStore(undefined);
  resetStagedContextStore();
  disposeProjector(SESSION);
  for (const db of databases.splice(0)) if (db.$client.open) db.$client.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('private document dispatch deadlines', () => {
  it('retains a real durable identity recovery hold hidden by the not-found authority response', async () => {
    const { f, accepted, runtime, options } = fixture(() => ({ decision: 'admit' }));
    const before = f.db.select().from(sessionMessageAcceptanceReceipts).get();
    f.db
      .insert(canvasDocIdentityIntents)
      .values({
        intentId: 'identity-hold',
        documentId: f.documentId,
        fromScope: 'session:session-1',
        toScope: 'session:canonical',
        sourceId: accepted.receipt.sourceId,
        sourceGeneration: accepted.receipt.sourceGeneration,
        evidence: {},
        status: 'in_doubt',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    const authorization = new DocChannelAuthorization(f.db, f.documents, {
      ownsInstallation: (claims) =>
        claims.owner.kind === 'local_install' && claims.owner.installationId === 'installation',
      principalCurrent: (proof) => proof === f.actor.principal,
      roomMembership: () => undefined,
    });
    f.authority.requireGrantedCurrent = (grant, tx) =>
      authorization.requireCurrent(grant.documentId, f.actor, true, tx);
    await expect(f.admission.acceptance.prepare(accepted.receipt.id)).rejects.toBeInstanceOf(
      DocChannelNotFoundError
    );
    adoptAcceptedPrivateMessages(options);
    await flush();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).get()).toEqual(before);
    expect(f.queue.get(accepted.receipt.queueMessageId)).toBeDefined();
    // Model recovery abandoning this uncommitted move, preserving its original scope.
    f.db
      .delete(canvasDocIdentityIntents)
      .where(eq(canvasDocIdentityIntents.intentId, 'identity-hold'))
      .run();
    noteTurnBoundary(SESSION);
    await flush();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
  it.each([
    new Error('Source temporarily unavailable'),
    new PrivateSessionMessageRefusalError('source_adapter_unavailable', 'Unavailable'),
    new PrivateSessionMessageRefusalError('document_identity_blocked', 'Recovery pending'),
    new PrivateSessionMessageRefusalError('dispatch_claim_raced', 'Another claimant'),
    new DocRouteGrantError('AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY'),
    new DocRouteGrantError('TEMPORARILY_UNAVAILABLE', 503),
  ])('retains accepted work after non-authority preclaim failure %s', async (failure) => {
    const { f, accepted, runtime, options } = fixture(() => ({ decision: 'admit' }));
    const before = f.db.select().from(sessionMessageAcceptanceReceipts).get();
    vi.spyOn(f.admission.source, 'prepare').mockRejectedValueOnce(failure);
    adoptAcceptedPrivateMessages(options);
    await flush();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).get()).toEqual(before);
    expect(f.queue.get(accepted.receipt.queueMessageId)).toBeDefined();
    noteTurnBoundary(SESSION);
    await flush();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('retains accepted work and staged notes after a real locked budget write, then retries once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'doc-budget-lock-'));
    directories.push(directory);
    const file = join(directory, 'state.db');
    let blocked = true;
    const { f, accepted, runtime, options } = fixture(() => {
      if (!blocked) return { decision: 'admit' };
      locker.$client.exec('BEGIN IMMEDIATE');
      return { decision: 'defer', reason: 'route_turn_ceiling', nextEligibleAt: DEADLINE };
    }, file);
    f.db.$client.pragma('journal_mode=DELETE');
    f.db.$client.pragma('busy_timeout=0');
    const locker = createDb(file);
    databases.push(locker);
    locker.$client.pragma('busy_timeout=0');
    setStagedContextStore(new StagedContextStore(f.db));
    holdStagedContext(SESSION, 'Preserve this note', 'locked-note');
    const take = vi.spyOn(StagedContextStore.prototype, 'take');
    const before = f.db.select().from(sessionMessageAcceptanceReceipts).get();
    const batchBefore = f.store.getBatch(accepted.receipt.sourceId);
    const originalClaim = f.admission.acceptance.claim.bind(f.admission.acceptance);
    let failure: unknown;
    vi.spyOn(f.admission.acceptance, 'claim').mockImplementation((...args) => {
      try {
        return originalClaim(...args);
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        if (locker.$client.inTransaction) locker.$client.exec('ROLLBACK');
      }
    });
    adoptAcceptedPrivateMessages(options);
    await flush();
    expect(failure).toMatchObject({ code: 'SQLITE_BUSY' });
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(take).not.toHaveBeenCalled();
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).get()).toEqual(before);
    expect(f.store.getBatch(accepted.receipt.sourceId)).toEqual(batchBefore);
    expect(f.queue.get(accepted.receipt.queueMessageId)).toBeDefined();
    expect(runtime.releaseLock).toHaveBeenCalled();
    blocked = false;
    noteTurnBoundary(SESSION);
    await flush();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(take).toHaveBeenCalledTimes(1);
    expect(runtime.sendMessage.mock.calls[0]?.[2]?.additionalContext).toEqual(
      expect.arrayContaining([
        { kind: 'staged_context', scope: 'per-turn', data: { text: 'Preserve this note' } },
      ])
    );
    noteTurnBoundary(SESSION);
    await flush();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).get()).toMatchObject({
      id: accepted.receipt.id,
      state: 'settled',
      settleOutcome: 'completed',
    });
  });
  it('parks a late deferral before repumping and lets ordinary work pass without changing identity', async () => {
    const { f, accepted, runtime, options } = fixture();
    const prepare = vi.spyOn(f.admission.source, 'prepare');
    const original = f.store.getBatch(accepted.receipt.sourceId)!;
    noteRuntimeTurnOpen(SESSION);
    expect(adoptAcceptedPrivateMessages(options)).toBe(1);
    await flush();
    expect(prepare).not.toHaveBeenCalled();
    noteRuntimeTurnClosed(SESSION);
    await flush();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(isTurnInFlight(SESSION, runtime)).toBe(false);
    expect(runtime.releaseLock).toHaveBeenCalled();
    expect(f.queue.get(accepted.receipt.queueMessageId)).toBeDefined();
    expect(f.store.getBatch(original.batchId)).toMatchObject({
      status: 'accepted',
      leaseUntil: DEADLINE,
      generation: original.generation,
      inputEventIds: original.inputEventIds,
      admissionReceiptId: accepted.receipt.id,
    });
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).get()).toMatchObject({
      id: accepted.receipt.id,
      state: 'accepted',
      originAuthorityDigest: accepted.receipt.originAuthorityDigest,
      sourceGeneration: accepted.receipt.sourceGeneration,
      dispatchAttemptId: null,
      turnStartSeq: null,
      settledAt: null,
      cancellationCode: null,
    });
    for (let i = 0; i < 5; i++) noteTurnBoundary(SESSION);
    await flush();
    expect(prepare).toHaveBeenCalledTimes(1);
    f.queue.enqueue({ sessionId: SESSION, clientId: 'person-window', content: 'ordinary work' });
    expect(adoptQueuedMessages(options)).toBe(1);
    await flush();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.sendMessage.mock.calls[0]?.[1]).toBe('ordinary work');
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(prepare).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).get()).toMatchObject({
      id: accepted.receipt.id,
      state: 'settled',
      settleOutcome: 'completed',
    });
  });

  it('retains staged notes through deferral and folds them into exactly one admitted turn', async () => {
    const { f, runtime, options } = fixture();
    setStagedContextStore(new StagedContextStore(f.db));
    holdStagedContext(SESSION, 'Keep the fake LifeOS priorities', 'staged-doc-note');
    const take = vi.spyOn(StagedContextStore.prototype, 'take');
    adoptAcceptedPrivateMessages(options);
    await flush();
    expect(take).not.toHaveBeenCalled();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await flush();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(take).toHaveBeenCalledTimes(1);
    expect(runtime.sendMessage.mock.calls[0]?.[2]?.additionalContext).toEqual(
      expect.arrayContaining([
        {
          kind: 'staged_context',
          scope: 'per-turn',
          data: { text: 'Keep the fake LifeOS priorities' },
        },
      ])
    );
    noteTurnBoundary(SESSION);
    await flush();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(take).toHaveBeenCalledTimes(1);
  });

  it('rechecks a newly persisted deadline before the forced ordinary wait-budget timer launches', async () => {
    const { f, accepted, runtime, options } = fixture(() => ({ decision: 'admit' }));
    noteRuntimeTurnOpen(SESSION);
    adoptAcceptedPrivateMessages(options);
    await flush();
    f.db
      .update(canvasDocBatches)
      .set({ leaseUntil: DEADLINE, errorCode: DOCUMENT_BUDGET_WAIT })
      .where(eq(canvasDocBatches.batchId, accepted.receipt.sourceId))
      .run();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    noteRuntimeTurnClosed(SESSION);
    await flush();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await flush();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('restores the durable deadline after a real SQLite reopen and dispatches the original receipt once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'doc-deadline-restart-'));
    directories.push(directory);
    const file = join(directory, 'state.db');
    const { f, accepted, runtime, options } = fixture(waitBudget, file);
    adoptAcceptedPrivateMessages(options);
    await flush();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    resetMessageDispatcher();
    disposeProjector(SESSION);
    f.db.$client.close();
    const db = createDb(file);
    databases.push(db);
    const reboot = batchFixture(
      file,
      null,
      { db, documentId: f.documentId, grantId: f.grantId },
      'boot-2',
      'claude-code',
      () => new Date(),
      waitBudget
    );
    const next = install(reboot);
    expect(adoptAcceptedPrivateMessages(next.options)).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(next.runtime.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(next.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(reboot.db.select().from(sessionMessageAcceptanceReceipts).get()).toMatchObject({
      id: accepted.receipt.id,
      sourceGeneration: accepted.receipt.sourceGeneration,
      state: 'settled',
    });
    expect(reboot.db.select().from(sessionMessageAcceptanceReceipts).all()).toHaveLength(1);
  });

  it('does not bypass a busy runtime when a recovered deadline expires', async () => {
    const { f, accepted, runtime, options } = fixture(() => ({ decision: 'admit' }));
    f.db
      .update(canvasDocBatches)
      .set({ leaseUntil: DEADLINE, errorCode: DOCUMENT_BUDGET_WAIT })
      .where(eq(canvasDocBatches.batchId, accepted.receipt.sourceId))
      .run();
    noteRuntimeTurnOpen(SESSION);
    adoptAcceptedPrivateMessages(options);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    noteRuntimeTurnClosed(SESSION);
    await flush();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('revalidates revocation at eligibility without repeating or settling deferred work', async () => {
    const { f, accepted, runtime, options } = fixture();
    adoptAcceptedPrivateMessages(options);
    await flush();
    f.grants.revoke(f.documentId, f.grantId, f.actor);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await flush();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).get()).toMatchObject({
      id: accepted.receipt.id,
      state: 'cancelled',
      dispatchAttemptId: null,
      turnStartSeq: null,
    });
  });

  it('retains a nonfinite recovered deadline and cleans up a cancelled retry timer', async () => {
    const { f, accepted, runtime, options } = fixture();
    f.db
      .update(canvasDocBatches)
      .set({ leaseUntil: 'invalid', errorCode: DOCUMENT_BUDGET_WAIT })
      .where(eq(canvasDocBatches.batchId, accepted.receipt.sourceId))
      .run();
    expect(adoptAcceptedPrivateMessages(options)).toBe(1);
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).get()).toMatchObject({
      id: accepted.receipt.id,
      state: 'accepted',
      cancellationCode: null,
      dispatchAttemptId: null,
    });
    expect(f.queue.get(accepted.receipt.queueMessageId)).toBeDefined();
    expect(cancelPendingDispatch(accepted.receipt.queueMessageId)).toBe(true);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    const next = fixture();
    adoptAcceptedPrivateMessages(next.options);
    await flush();
    expect(cancelPendingDispatch(next.accepted.receipt.queueMessageId)).toBe(true);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(next.runtime.sendMessage).not.toHaveBeenCalled();
    expect(next.f.queue.get(next.accepted.receipt.queueMessageId)).toBeDefined();
  });
});
