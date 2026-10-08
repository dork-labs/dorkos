/** Approved host focus reaches the original native Room FIRST, separately from its HTTP receipt. */
import express from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { and, eq, sql, canvasDocBatches, canvasDocDeliveries, canvasDocEvents } from '@dorkos/db';
import router from '../../../../../routes/canvas-doc-events.js';
import { nativeRoomAuthorityFixture } from './authority-fixtures.js';
import {
  currentRoomDueServicePort,
  readServiceOriginalRoomScenarioEvidence,
} from '../../service.js';
import { RuntimeRegistry } from '../../../../core/runtime-registry.js';
import {
  TestModeRuntime,
  captureTestModeOriginalRoomEmitter,
  readTestModeOriginalScenarioCounts,
} from '../../../../runtimes/test-mode/test-mode-runtime.js';
import { scenarioStore } from '../../../../runtimes/test-mode/scenario-store.js';
import { interactionGate } from '../../../../runtimes/test-mode/interaction-gate.js';
import { env as serverEnv } from '../../../../../env.js';

const target = swappableServer();

it('admits one genuine native turn for operator-approved focus and correlates its ACK and remaining reply', async () => {
  const agentPath = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'focus-first-')));
  const sessionId = randomUUID();
  let h: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
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
    h = await nativeRoomAuthorityFixture(agentPath, 'claude-code', sessionId, randomUUID());
    const actual = h;
    actual.http.grants.configure(
      actual.documentId,
      {
        routes: [
          {
            id: 'approved-focus',
            on: 'host.focus',
            to: 'room:self',
            turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 2 },
          },
        ],
      },
      actual.operator,
      actual.originalTarget.agentId
    );
    const approvalRequest = {
      documentId: actual.documentId,
      routeId: 'approved-focus',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    const pending = actual.http.grants.grant(approvalRequest, actual.operator);
    expect(pending.kind).toBe('approval_required');
    if (pending.kind !== 'approval_required')
      throw new Error('Original focus approval ticket missing');
    actual.approvals.grant(pending.ticket.approvalId);
    const granted = actual.http.grants.grant(
      approvalRequest,
      actual.operator,
      pending.ticket.token
    );
    expect(granted.kind).toBe('granted');
    if (granted.kind !== 'granted') throw new Error('Original consumed focus approval missing');

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
    const app = express();
    app.use(express.json());
    app.locals.docChannelHttp = { service: actual.http.service, actor: () => actual.operator };
    app.use('/docs', router);
    const server = target.mount(app),
      path = `/docs/${actual.documentId}/presence`;
    const mounted = await request(server).post(path).send({ action: 'mount' });
    expect(mounted.status).toBe(200);
    const viewerId = mounted.body.viewerId;
    expect(
      (await request(server).post(path).send({ action: 'focus', viewerId, focused: true })).status
    ).toBe(200);
    const rows = () =>
      actual.db
        .select()
        .from(canvasDocEvents)
        .where(eq(canvasDocEvents.documentId, actual.documentId))
        .all();
    expect(rows().filter((row) => row.type === 'host.focus')).toHaveLength(1);
    const admissions = () =>
      actual.db.all<{ batch_id: string; status: string; turn_id: string | null }>(
        sql`SELECT batch_id,status,turn_id FROM room_doc_admissions WHERE document_id=${actual.documentId}`
      );
    expect(admissions()).toEqual([]);
    expect(readTestModeOriginalScenarioCounts(runtime)).toEqual({ scenarioStarts: 0 });
    // Exercise the real burst boundary; no timer, TTL or native clock is replaced.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    expect(
      (await request(server).post(path).send({ action: 'focus', viewerId, focused: false })).status
    ).toBe(200);
    const focus = rows().filter((row) => row.type === 'host.focus');
    expect(focus.map((row) => row.payload)).toEqual([{ focused: true }, { focused: false }]);
    const batches = actual.db
      .select()
      .from(canvasDocBatches)
      .where(eq(canvasDocBatches.documentId, actual.documentId))
      .all();
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch).toMatchObject({
      routeId: 'approved-focus',
      grantId: granted.grant.grantId,
      status: 'pending',
      inputEventIds: focus.map((row) => row.eventId),
    });
    expect(admissions()).toEqual([]);
    actual.http.channels.getBatch = () => {
      throw new Error('Reflected focus batch reader used');
    };
    actual.http.grants.revalidateGrant = () => {
      throw new Error('Reflected focus grant authority used');
    };
    const port = currentRoomDueServicePort(actual.http.service);
    // Reach the declaration's actual due time before invoking the fixed one-shot pump.
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(batch.dueAt) - Date.now()))
    );
    // Due-time passage does not mint frozen custody: invoke the original native wake first.
    port.wake();
    expect(
      actual.db
        .select()
        .from(canvasDocBatches)
        .where(eq(canvasDocBatches.batchId, batch.batchId))
        .get()!.status
    ).toBe('accepted');
    expect(admissions()).toEqual([]);
    expect(readTestModeOriginalScenarioCounts(runtime)).toEqual({ scenarioStarts: 0 });
    pump = port.pump(registry);
    void pump.catch(remember);
    const delivery = (eventId: string) =>
      actual.db
        .select()
        .from(canvasDocDeliveries)
        .where(
          and(
            eq(canvasDocDeliveries.documentId, actual.documentId),
            eq(canvasDocDeliveries.eventId, eventId)
          )
        )
        .get()!;
    await vi.waitFor(() => expect(delivery(focus[0]!.eventId).ackOutcome).toBe('handled'));
    expect(admissions()).toHaveLength(1);
    expect(admissions()[0]).toMatchObject({ batch_id: batch.batchId, status: 'turn_started' });
    expect(admissions()[0]!.turn_id).not.toBeNull();
    expect(readTestModeOriginalScenarioCounts(runtime)).toEqual({ scenarioStarts: 1 });
    expect(
      actual.db
        .select()
        .from(canvasDocBatches)
        .where(eq(canvasDocBatches.batchId, batch.batchId))
        .get()!.status
    ).toBe('turn_started');
    // A repeated current focus is quiet while the genuine admitted turn remains held.
    expect(
      (await request(server).post(path).send({ action: 'focus', viewerId, focused: false })).status
    ).toBe(200);
    expect(rows().filter((row) => row.type === 'host.focus')).toEqual(focus);
    await vi.waitFor(() => expect(interactionGate.step(sessionId)).toBe(true));
    await pump;
    expect(delivery(focus[0]!.eventId).ackOutcome).toBe('handled');
    expect(delivery(focus[1]!.eventId).ackOutcome).toBeNull();
    expect(
      rows()
        .filter((row) => row.type === 'app.ack')
        .map((row) => row.payload)
    ).toEqual([
      {
        batchId: batch.batchId,
        routeId: 'approved-focus',
        eventIds: [focus[0]!.eventId],
        outcome: 'handled',
      },
    ]);
    expect(
      rows()
        .filter((row) => row.type === 'agent.reply')
        .map((row) => row.payload)
    ).toEqual([{ inReplyTo: [focus[1]!.eventId], text: 'Original native second-input reply' }]);
    expect(readTestModeOriginalScenarioCounts(runtime)).toEqual({ scenarioStarts: 1 });
    expect(admissions()).toHaveLength(1);
    expect(
      actual.db
        .select()
        .from(canvasDocBatches)
        .where(eq(canvasDocBatches.documentId, actual.documentId))
        .all()
    ).toHaveLength(1);
  } catch (cause) {
    remember(cause);
    // Failure-only DATA from this same original native fixture, before its owning stop.
    // No payloads, bearer, path or principal is disclosed; absence proves nothing.
    if (h) {
      try {
        const batchRows = h.db
          .select()
          .from(canvasDocBatches)
          .where(eq(canvasDocBatches.documentId, h.documentId))
          .all();
        const deliveryRows = h.db
          .select()
          .from(canvasDocDeliveries)
          .where(eq(canvasDocDeliveries.documentId, h.documentId))
          .all();
        const eventRows = h.db
          .select()
          .from(canvasDocEvents)
          .where(eq(canvasDocEvents.documentId, h.documentId))
          .all();
        const admissionRows = h.db.all<{ status: string }>(
          sql`SELECT status FROM room_doc_admissions WHERE document_id=${h.documentId}`
        );
        const frontier = batchRows.slice(0, 4).map((batch) => ({
          status: batch.status,
          errorCode:
            batch.errorCode === null
              ? null
              : /^[A-Z0-9_]{1,96}$/.test(batch.errorCode)
                ? batch.errorCode
                : 'NON_CODE_ERROR',
          inputs: batch.inputEventIds.length,
          scenario: (() => {
            const own = readServiceOriginalRoomScenarioEvidence(
              h!.http.service,
              h!.documentId,
              batch.batchId,
              batch.generation
            );
            return own
              ? {
                  scenarioStarts: own.scenarioStarts,
                  retired: own.retired,
                  operationFailed: own.operationFailed,
                  cleanupClosed: own.cleanupClosed,
                }
              : null;
          })(),
          acknowledgements: batch.inputEventIds
            .slice(0, 2)
            .map(
              (id) => deliveryRows.find((delivery) => delivery.eventId === id)?.ackOutcome ?? null
            ),
        }));
        process.stderr.write(
          `ORIGINAL_FOCUS_FIRST_FRONTIER ${JSON.stringify({
            batches: batchRows.length,
            frontier,
            admissionStatuses: admissionRows.slice(0, 4).map((row) => row.status),
            acknowledgements: eventRows.filter((row) => row.type === 'app.ack').length,
            replies: eventRows.filter((row) => row.type === 'agent.reply').length,
          })}\n`
        );
      } catch {
        /* Original assertion/operation cause remains first. */
      }
    }
  }
  // Start genuine stop before joining the held stream; UNKNOWN retains its native resources.
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
  // Scenario DATA cleanup is attempted independently, including failed/UNKNOWN native stop.
  try {
    scenarioStore.clearSession(sessionId);
  } catch (cause) {
    remember(cause);
  }
  if (closed) {
    try {
      await fs.rm(agentPath, { recursive: true, force: true });
    } catch (cause) {
      remember(cause);
    }
  }
  if (failed) throw first;
});
