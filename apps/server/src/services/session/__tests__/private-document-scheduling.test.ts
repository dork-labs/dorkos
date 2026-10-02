/** Durable document deadlines cross the actual coordinator, queue and runtime boundary. */
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  canvasDocBatches,
  sessionMessageQueue,
  sessionStagedContext,
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
  noteTurnBoundary,
  resetMessageDispatcher,
} from '../message-dispatcher.js';
import { setPrivateSessionMessageAcceptanceService } from '../private-messages/acceptance.js';
import { PrivateSessionMessageRefusalError } from '../private-messages/refusal.js';
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

it.each(['malformed', 'unavailable', 'unknown'] as const)(
  'retains accepted identity and uses a bounded retry when adoption scheduling is %s',
  async (failure) => {
    const { f, accepted, runtime, options } = fixture(() => ({ decision: 'admit' }));
    setStagedContextStore(new StagedContextStore(f.db));
    holdStagedContext(SESSION, 'Preserve scheduling note', 'schedule-note');
    let broken = true;
    const original = f.admission.source.dispatchNotBefore.bind(f.admission.source);
    const scheduling = vi.spyOn(f.admission.source, 'dispatchNotBefore');
    if (failure === 'malformed') {
      f.db
        .update(canvasDocBatches)
        .set({ errorCode: DOCUMENT_BUDGET_WAIT, leaseUntil: 'invalid-date' })
        .where(eq(canvasDocBatches.batchId, accepted.receipt.sourceId))
        .run();
      scheduling.mockImplementation(original);
    } else
      scheduling.mockImplementation((receipt) => {
        if (broken)
          throw failure === 'unavailable'
            ? new PrivateSessionMessageRefusalError('source_adapter_unavailable', 'Unavailable')
            : new Error('Unavailable');
        return original(receipt);
      });
    const receipts = f.db.select().from(sessionMessageAcceptanceReceipts).all();
    const queue = f.db.select().from(sessionMessageQueue).all();
    const staged = f.db.select().from(sessionStagedContext).all();
    const batch = f.store.getBatch(accepted.receipt.sourceId)!;
    const inputs = batch.inputEventIds.map((id) => f.store.getEvent(f.documentId, id));
    expect(adoptAcceptedPrivateMessages(options)).toBe(1);
    await flush();
    expect(adoptAcceptedPrivateMessages(options)).toBe(0);
    expect(scheduling).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(scheduling).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(scheduling).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(scheduling).toHaveBeenCalledTimes(2);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual(receipts);
    expect(f.db.select().from(sessionMessageQueue).all()).toEqual(queue);
    expect(f.db.select().from(sessionStagedContext).all()).toEqual(staged);
    expect(f.store.getBatch(accepted.receipt.sourceId)).toEqual(batch);
    expect(batch.inputEventIds.map((id) => f.store.getEvent(f.documentId, id))).toEqual(inputs);
    broken = false;
    if (failure === 'malformed')
      f.db
        .update(canvasDocBatches)
        .set({ errorCode: null, leaseUntil: null })
        .where(eq(canvasDocBatches.batchId, batch.batchId))
        .run();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(
      runtime.sendMessage.mock.calls[0]?.[2]?.additionalContext?.filter(
        (item) => item.kind === 'staged_context'
      )
    ).toEqual([
      { kind: 'staged_context', scope: 'per-turn', data: { text: 'Preserve scheduling note' } },
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
    noteTurnBoundary(SESSION);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  }
);

it('preserves a real budget defer when its subsequent parking schedule temporarily fails', async () => {
  const { f, accepted, runtime, options } = fixture();
  setStagedContextStore(new StagedContextStore(f.db));
  holdStagedContext(SESSION, 'Preserve deferred note', 'deferred-note');
  const original = f.admission.source.dispatchNotBefore.bind(f.admission.source);
  let broken = true;
  const scheduling = vi
    .spyOn(f.admission.source, 'dispatchNotBefore')
    .mockImplementation((receipt) => {
      const deadline = original(receipt);
      if (broken && deadline)
        throw new PrivateSessionMessageRefusalError('source_adapter_unavailable', 'Unavailable');
      return deadline;
    });
  const receipts = f.db.select().from(sessionMessageAcceptanceReceipts).all();
  const queued = f.db.select().from(sessionMessageQueue).all();
  const staged = f.db.select().from(sessionStagedContext).all();
  adoptAcceptedPrivateMessages(options);
  await flush();
  expect(f.store.getBatch(accepted.receipt.sourceId)).toMatchObject({
    status: 'accepted',
    errorCode: DOCUMENT_BUDGET_WAIT,
    leaseUntil: DEADLINE,
  });
  expect(f.db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual(receipts);
  expect(f.db.select().from(sessionMessageQueue).all()).toEqual(queued);
  expect(f.db.select().from(sessionStagedContext).all()).toEqual(staged);
  expect(runtime.sendMessage).not.toHaveBeenCalled();
  const calls = scheduling.mock.calls.length;
  await vi.advanceTimersByTimeAsync(999);
  expect(scheduling).toHaveBeenCalledTimes(calls);
  await vi.advanceTimersByTimeAsync(1);
  expect(scheduling).toHaveBeenCalledTimes(calls + 1);
  broken = false;
  await vi.advanceTimersByTimeAsync(1000);
  expect(runtime.sendMessage).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(Date.parse(DEADLINE) - Date.now());
  await flush();
  expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  expect(f.db.select().from(sessionMessageAcceptanceReceipts).get()).toMatchObject({
    id: accepted.receipt.id,
    sourceId: accepted.receipt.sourceId,
    sourceGeneration: accepted.receipt.sourceGeneration,
    state: 'settled',
  });
  expect(
    runtime.sendMessage.mock.calls[0]?.[2]?.additionalContext?.filter(
      (item) => item.kind === 'staged_context'
    )
  ).toEqual([
    { kind: 'staged_context', scope: 'per-turn', data: { text: 'Preserve deferred note' } },
  ]);
});

it.each(['adoption', 'parked-recheck'] as const)(
  'cancels only a proven permanent scheduling refusal at %s',
  async (boundary) => {
    const { f, accepted, runtime, options } = fixture();
    if (boundary === 'parked-recheck') {
      adoptAcceptedPrivateMessages(options);
      await flush();
    }
    f.grants.revoke(f.documentId, f.grantId, f.actor);
    let refusal: unknown;
    vi.spyOn(f.admission.source, 'dispatchNotBefore').mockImplementation(() => {
      try {
        f.store.transaction((tx) =>
          f.grants.revalidateBatchGrant(f.store.getBatch(accepted.receipt.sourceId)!, tx)
        );
      } catch (error) {
        refusal = error;
        throw error;
      }
      throw new Error('Revoked grant unexpectedly authorized scheduling');
    });
    if (boundary === 'adoption') adoptAcceptedPrivateMessages(options);
    else await vi.advanceTimersByTimeAsync(Date.parse(DEADLINE) - Date.now());
    await flush();
    expect(refusal).toMatchObject({ code: 'GRANT_REVOKED' });
    expect(f.admission.source.isPreclaimRefusal(refusal)).toBe(true);
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(f.db.select().from(sessionMessageAcceptanceReceipts).get()).toMatchObject({
      id: accepted.receipt.id,
      state: 'cancelled',
      cancellationCode: 'authority_changed_before_dispatch',
    });
    expect(f.store.getBatch(accepted.receipt.sourceId)?.status).toBe('cancelled');
    expect(f.db.select().from(sessionMessageQueue).all()).toEqual([]);
  }
);
