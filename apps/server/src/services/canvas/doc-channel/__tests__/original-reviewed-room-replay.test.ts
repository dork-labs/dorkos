/** Explicit Room review uses the original operator, native source freeze and actual FIRST/ACK. */
import { randomUUID } from 'node:crypto';
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

// Arrangement has its own default hook budget; operational work retains the default body budget.
let agentPath: string;
let sessionId: string;
let agentId: string;
let fixture: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
let setupPending: Promise<void>;
let bodyPending: Promise<void> | undefined;
let bodyCleanupCompleted = false;
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
  bodyPending = undefined;
  bodyCleanupCompleted = false;
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
  })();
  // Observe rejection immediately while retaining this exact owning setup promise.
  void setupPending.catch(rememberLifecycle);
  await setupPending;
});
afterEach(async () => {
  await (fallbackCleanup ??= (async () => {
    // A Vitest timeout is not cancellation. Never close resources ahead of late setup/body work.
    await setupPending.catch(rememberLifecycle);
    if (bodyPending) await bodyPending.catch(rememberLifecycle);
    if (bodyCleanupCompleted) return;
    // No completed body teardown owns a returned fixture. Its genuine cleanup joins native drains.
    let closed = false;
    if (fixture) {
      try {
        await fixture.cleanup();
        closed = true;
      } catch (cause) {
        rememberLifecycle(cause);
      }
    }
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
  bodyPending = (async () => {
    const h = fixture;
    if (!h) throw new Error('Original per-test native fixture did not finish setup');
    let pump: Promise<void> | undefined;
    let failed = false,
      first: unknown,
      closed = false;
    const remember = (cause: unknown) => {
      if (!failed) {
        failed = true;
        first = cause;
      }
    };
    try {
      const actual = h;
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
      const port = currentRoomDueServicePort(actual.http.service);
      pump = port.pump(registry);
      void pump.catch(remember);
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
      expect(
        await replayServiceOriginalExpiredDocBatch(actual.http.service, request, actual.operator)
      ).toEqual({ ...replayed, status: 'duplicate' });
      await expect(
        replayServiceOriginalExpiredDocBatch(
          actual.http.service,
          { ...request, eventId: randomUUID() },
          actual.operator
        )
      ).rejects.toThrow();
      await vi.waitFor(() => expect(interactionGate.step(sessionId)).toBe(true));
      await pump;
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
    // The genuine stop starts before joining a possibly held scenario; UNKNOWN never closes its database.
    if (h) {
      let stopClosed = false;
      await Promise.allSettled([
        Promise.resolve()
          .then(() => currentRoomDueServicePort(h!.http.service).stopPump())
          .then(() => {
            stopClosed = true;
          })
          .catch(remember),
        ...(pump ? [pump.catch(remember)] : []),
      ]);
      if (stopClosed) {
        try {
          await h.cleanup();
          closed = true;
        } catch (cause) {
          remember(cause);
        }
      }
    }
    // A constructor that did not return a fixture may still retain native custody.
    if (closed) {
      try {
        await fs.rm(agentPath, { recursive: true, force: true });
      } catch (cause) {
        remember(cause);
      }
    }
    bodyCleanupCompleted = true;
    if (failed) throw first;
  })();
  void bodyPending.catch(rememberLifecycle);
  return bodyPending;
});
