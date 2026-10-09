/** Explicit Room review uses the original operator, native source freeze and actual FIRST/ACK. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  and,
  eq,
  sql,
  canvasDocuments,
  canvasDocChannels,
  canvasDocBatches,
  canvasDocDeliveries,
  canvasDocEvents,
} from '@dorkos/db';
import { nativeRoomAuthorityFixture } from '../writes/__tests__/authority-fixtures.js';
import { docDocumentGeneration } from '../identity/incarnation.js';
import {
  submitCurrentDocEvent,
  replayServiceOriginalExpiredDocBatch,
  readServiceOriginalDocManagement,
  currentRoomDueServicePort,
} from '../service.js';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import {
  TestModeRuntime,
  readTestModeOriginalScenarioCounts,
  captureTestModeOriginalRoomEmitter,
} from '../../../runtimes/test-mode/test-mode-runtime.js';
import { scenarioStore } from '../../../runtimes/test-mode/scenario-store.js';
import { interactionGate } from '../../../runtimes/test-mode/interaction-gate.js';
import { env as serverEnv } from '../../../../env.js';

type NativeRoomFixture = Awaited<ReturnType<typeof nativeRoomAuthorityFixture>>;

async function prepareReviewContext(actual: NativeRoomFixture) {
  const previousMode = serverEnv.DORKOS_TEST_RUNTIME;
  let runtime: TestModeRuntime;
  try {
    serverEnv.DORKOS_TEST_RUNTIME = true;
    runtime = new TestModeRuntime('claude-code', actual.principals);
  } finally {
    serverEnv.DORKOS_TEST_RUNTIME = previousMode;
  }
  captureTestModeOriginalRoomEmitter(
    runtime,
    actual.http.fileWrites,
    actual.db,
    actual.http.channels
  );
  const registry = new RuntimeRegistry();
  registry.setDb(actual.db);
  registry.register(runtime);
  scenarioStore.setForSession(sessionId, 'native-room-partial-ack-reply');
  const physical = actual.db
    .select()
    .from(canvasDocuments)
    .where(eq(canvasDocuments.id, actual.documentId))
    .get()!;
  const channel = actual.db
    .select()
    .from(canvasDocChannels)
    .where(eq(canvasDocChannels.documentId, actual.documentId))
    .get()!;
  const condition = { expectedGeneration: docDocumentGeneration(physical, channel) };
  const events = [0, 1].map((index) => ({
    v: 1 as const,
    id: randomUUID(),
    type: 'md.comment',
    payload: { text: `Reviewed input ${index}` },
  }));
  for (const event of events)
    await submitCurrentDocEvent(
      actual.http.service,
      actual.documentId,
      event,
      actual.operator,
      condition
    );
  return { actual, runtime, registry, condition, events };
}

// Arrangement has its own default hook budget; operational work retains the default body budget.
let agentPath: string;
let sessionId: string;
let agentId: string;
let fixture: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
let prepared: Awaited<ReturnType<typeof prepareReviewContext>> | undefined;
let setupPending: Promise<void>;
let bodyPending: Promise<void> | undefined;
let bodySettled = false;
let admissionOpen = true;
let pumpPending: Promise<void> | undefined;
let stopPending: Promise<void> | undefined;
let stopClosed = false;
let bodyStartedAt = 0;
let phaseStartedAt = 0;
let lastPhase = 'not-started';
const phase = (name: string) => {
  lastPhase = name;
  phaseStartedAt = performance.now();
};
const reportUnsettledBody = () => {
  try {
    const now = performance.now();
    console.error(
      'ORIGINAL_REVIEW_BODY_UNSETTLED',
      JSON.stringify({
        phase: lastPhase,
        bodyElapsedMs: Math.round(now - bodyStartedAt),
        phaseElapsedMs: Math.round(now - phaseStartedAt),
      })
    );
  } catch {
    // Diagnostic DATA must not replace the original operational or cleanup failure.
  }
};
let fallbackCleanup: Promise<void> | undefined;
let lifecycleFailed = false;
let lifecycleFirst: unknown;
const rememberLifecycle = (cause: unknown) => {
  if (!lifecycleFailed) {
    lifecycleFailed = true;
    lifecycleFirst = cause;
  }
};
beforeEach(async () => {
  fixture = undefined;
  prepared = undefined;
  bodyPending = undefined;
  bodySettled = false;
  admissionOpen = true;
  pumpPending = undefined;
  stopPending = undefined;
  stopClosed = false;
  bodyStartedAt = 0;
  phaseStartedAt = 0;
  lastPhase = 'not-started';
  fallbackCleanup = undefined;
  lifecycleFailed = false;
  lifecycleFirst = undefined;
  setupPending = (async () => {
    agentPath = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'review-room-')));
    sessionId = randomUUID();
    agentId = randomUUID();
    fixture = await nativeRoomAuthorityFixture(agentPath, 'claude-code', sessionId, agentId, {
      coalesceWindowMs: 60000,
    });
    prepared = await prepareReviewContext(fixture);
  })();
  // Observe rejection immediately while retaining this exact owning setup promise.
  void setupPending.catch(rememberLifecycle);
  await setupPending;
});
afterEach(async () => {
  // Retire admission before any await: a timed-out body cannot start a late pump.
  admissionOpen = false;
  if (bodyPending && !bodySettled) reportUnsettledBody();
  await (fallbackCleanup ??= (async () => {
    // A timeout is not cancellation. Join late setup before selecting its genuine owner.
    await setupPending.catch(rememberLifecycle);
    if (fixture) {
      // Start genuine stop BEFORE joining a body that may itself be waiting on the pump.
      stopPending ??= Promise.resolve()
        .then(() => currentRoomDueServicePort(fixture!.http.service).stopPump())
        .then(() => {
          stopClosed = true;
        });
      void stopPending.catch(rememberLifecycle);
    }
    await Promise.allSettled([
      ...(stopPending ? [stopPending.catch(rememberLifecycle)] : []),
      ...(bodyPending ? [bodyPending.catch(rememberLifecycle)] : []),
    ]);
    // Body settlement closes pump admission; join the exact pump before touching its database.
    if (pumpPending) await pumpPending.catch(rememberLifecycle);
    let closed = false;
    if (fixture && stopClosed) {
      try {
        await fixture.cleanup();
        closed = true;
      } catch (cause) {
        rememberLifecycle(cause);
      }
    }
    // UNKNOWN stop/cleanup custody never closes or removes the fixture's directory.
    if (closed) {
      try {
        await fs.rm(agentPath, { recursive: true, force: true });
      } catch (cause) {
        rememberLifecycle(cause);
      }
    }
    if (lifecycleFailed) throw lifecycleFirst;
  })());
});

it('reviews expired never-admitted Room inputs once, preserves original inputs and starts one genuine acknowledged native turn', () => {
  bodyStartedAt = performance.now();
  phase('initial-assertions');
  bodyPending = (async () => {
    const h = fixture;
    if (!h) throw new Error('Original per-test native fixture did not finish setup');
    let pump: Promise<void> | undefined;
    let failed = false,
      first: unknown;
    const remember = (cause: unknown) => {
      rememberLifecycle(cause);
      if (!failed) {
        failed = true;
        first = cause;
      }
    };
    try {
      const context = prepared;
      if (!context) throw new Error('Original review inputs did not finish setup');
      const { actual, runtime, registry, condition, events } = context;
      const old = actual.db
        .select()
        .from(canvasDocBatches)
        .where(eq(canvasDocBatches.documentId, actual.documentId))
        .get()!;
      expect(old.status).toBe('pending');
      expect(old.inputEventIds).toEqual(events.map((event) => event.id));
      expect(old.roomAdmissionId).toBeNull();
      expect(old.roomSourceJson).toBeNull();
      const originals = events.map((event) =>
        actual.db
          .select()
          .from(canvasDocEvents)
          .where(
            and(
              eq(canvasDocEvents.documentId, actual.documentId),
              eq(canvasDocEvents.eventId, event.id)
            )
          )
          .get()!
      );
      // Persist the real scheduler's terminal DATA state; no admission, permit or source capsule is minted.
      actual.db.transaction((tx) => {
        tx.update(canvasDocBatches)
          .set({ status: 'expired' })
          .where(eq(canvasDocBatches.batchId, old.batchId))
          .run();
        tx.update(canvasDocDeliveries)
          .set({ status: 'expired' })
          .where(eq(canvasDocDeliveries.batchId, old.batchId))
          .run();
      });
      const request = {
        documentId: actual.documentId,
        expectedGeneration: condition.expectedGeneration,
        eventId: randomUUID(),
        batchId: old.batchId,
        expectedBatchGeneration: old.generation,
        grantId: actual.granted.grant.grantId,
      };
      phase('management-read');
      const review = await readServiceOriginalDocManagement(
        actual.http.service,
        actual.documentId,
        actual.operator
      );
      expect(review.reviews.find((row) => row.batchId === old.batchId)?.replayAvailable).toBe(true);
      actual.http.channels.getBatch = () => {
        throw new Error('Reflected replay reader used');
      };
      actual.http.grants.revalidateGrant = () => {
        throw new Error('Reflected replay authority used');
      };
      phase('original-replay');
      const replayed = await replayServiceOriginalExpiredDocBatch(
        actual.http.service,
        request,
        actual.operator
      );
      expect(replayed.status).toBe('pending');
      expect(replayed.batchId).not.toBe(old.batchId);
      expect(replayed.generation).not.toBe(old.generation);
      const next = actual.db
        .select()
        .from(canvasDocBatches)
        .where(eq(canvasDocBatches.batchId, replayed.batchId))
        .get()!;
      expect(next.inputEventIds).toEqual(old.inputEventIds);
      // Original native freeze may reserve a source/admission ID, but only actual FIRST spends it.
      expect(
        actual.db.get<{ n: number }>(
          sql`SELECT count(*) AS n FROM room_doc_admissions WHERE document_id=${actual.documentId}`
        )!.n
      ).toBe(0);
      if (!admissionOpen) throw new Error('Original review pump admission retired');
      phase('pump-start');
      const port = currentRoomDueServicePort(actual.http.service);
      pump = port.pump(registry);
      pumpPending = pump;
      void pump.catch(remember);
      phase('first-ack');
      await vi.waitFor(() => {
        const firstDelivery = actual.db
          .select()
          .from(canvasDocDeliveries)
          .where(
            and(
              eq(canvasDocDeliveries.documentId, actual.documentId),
              eq(canvasDocDeliveries.eventId, events[0]!.id)
            )
          )
          .get()!;
        expect(firstDelivery.ackOutcome).toBe('handled');
      });
      expect(
        actual.db.get<{ n: number }>(
          sql`SELECT count(*) AS n FROM room_doc_admissions WHERE document_id=${actual.documentId}`
        )!.n
      ).toBe(1);
      expect(readTestModeOriginalScenarioCounts(runtime)).toEqual({ scenarioStarts: 1 });
      phase('duplicate-replay');
      expect(
        await replayServiceOriginalExpiredDocBatch(actual.http.service, request, actual.operator)
      ).toEqual({ ...replayed, status: 'duplicate' });
      phase('different-input-rejection');
      await expect(
        replayServiceOriginalExpiredDocBatch(
          actual.http.service,
          { ...request, eventId: randomUUID() },
          actual.operator
        )
      ).rejects.toThrow();
      phase('interaction-gate');
      await vi.waitFor(() => expect(interactionGate.step(sessionId)).toBe(true));
      phase('pump-join');
      await pump;
      phase('final-assertions');
      const finalDeliveries = events.map((event) =>
        actual.db
          .select()
          .from(canvasDocDeliveries)
          .where(
            and(
              eq(canvasDocDeliveries.documentId, actual.documentId),
              eq(canvasDocDeliveries.eventId, event.id)
            )
          )
          .get()!
      );
      expect(finalDeliveries[0]!.ackOutcome).toBe('handled');
      expect(finalDeliveries[1]!.ackOutcome).toBeNull();
      const emitted = actual.db
        .select()
        .from(canvasDocEvents)
        .where(eq(canvasDocEvents.documentId, actual.documentId))
        .all();
      const acknowledgements = emitted.filter((event) => event.type === 'app.ack');
      const replies = emitted.filter((event) => event.type === 'agent.reply');
      expect(acknowledgements).toHaveLength(1);
      expect(acknowledgements[0]!.payload).toMatchObject({
        batchId: replayed.batchId,
        routeId: old.routeId,
        eventIds: [events[0]!.id],
        outcome: 'handled',
      });
      expect(replies).toHaveLength(1);
      expect(replies[0]!.payload).toEqual({
        inReplyTo: [events[1]!.id],
        text: 'Original native second-input reply',
      });
      expect(finalDeliveries.every((row) => row.batchId === replayed.batchId)).toBe(true);
      expect(
        actual.db
          .select()
          .from(canvasDocBatches)
          .where(eq(canvasDocBatches.batchId, replayed.batchId))
          .get()!.generation
      ).toBe(replayed.generation);
      expect(readTestModeOriginalScenarioCounts(runtime)).toEqual({ scenarioStarts: 1 });
      expect(
        actual.db.get<{ n: number }>(
          sql`SELECT count(*) AS n FROM room_doc_admissions WHERE document_id=${actual.documentId}`
        )!.n
      ).toBe(1);
      expect(
        actual.db
          .select()
          .from(canvasDocBatches)
          .where(eq(canvasDocBatches.documentId, actual.documentId))
          .all()
      ).toHaveLength(2);
      for (const original of originals)
        expect(
          actual.db
            .select()
            .from(canvasDocEvents)
            .where(
              and(
                eq(canvasDocEvents.documentId, actual.documentId),
                eq(canvasDocEvents.eventId, original.eventId)
              )
            )
            .get()
        ).toEqual(original);
    } catch (cause) {
      remember(cause);
    }
    if (failed) throw first;
  })().finally(() => {
    bodySettled = true;
  });
  void bodyPending.catch(rememberLifecycle);
  return bodyPending;
});
