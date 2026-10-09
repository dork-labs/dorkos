/** Real SQLite restart retains pre-due custody without converting it into admission. */
import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from '@dorkos/db';
import {
  nativeRoomAuthorityFixture,
  reopenNativeRoomAuthorityFixture,
} from '../writes/__tests__/authority-fixtures.js';
import {
  currentRoomDueServicePort,
  replayServiceCurrentDoc,
  submitCurrentDocEvent,
  replayServiceOriginalExpiredDocBatch,
} from '../service.js';
import { stopInstallationFileWrites } from '../writes/installation-file-writes.js';
import { DocBatchDeliveryPump } from '../delivery/pump.js';
import { DocBatchAdmission } from '../delivery/batch-admission.js';
import { createPrivateDocPumpGates } from '../delivery/private-gates.js';
import { privateDocTurnBudget } from '../delivery/final-budget.js';
import { DocChannelLifecycle } from '../lifecycle.js';
import { MessageQueueStore } from '../../../session/message-queue-store.js';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import { retainDocHistory } from '../retention.js';
import { protectedCapacityQuery } from '../current/accounting.js';

it('rehydrates a genuinely pending Room capsule across close/reopen, coalesces its original slice, and resumes only explicit new work after native expiry', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'original-pending-room-restart-'));
  let h: Awaited<ReturnType<typeof nativeRoomAuthorityFixture>> | undefined;
  const successors: Awaited<ReturnType<typeof reopenNativeRoomAuthorityFixture>>[] = [];
  let failed = false,
    first: unknown,
    allClosed = false;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  const closeNative = async (actual: NonNullable<typeof h> | (typeof successors)[number]) => {
    let closed = true;
    await Promise.allSettled([
      Promise.resolve()
        .then(() =>
          stopInstallationFileWrites(actual.http.fileWrites, actual.db, actual.http.channels)
        )
        .catch((cause) => {
          closed = false;
          remember(cause);
        }),
      Promise.resolve()
        .then(() => currentRoomDueServicePort(actual.http.service).stopPump())
        .catch((cause) => {
          closed = false;
          remember(cause);
        }),
    ]);
    if (!closed) throw first;
    actual.db.$client.close();
    expect(actual.db.$client.open).toBe(false);
  };
  try {
    h = await nativeRoomAuthorityFixture(root, 'claude-code', randomUUID(), randomUUID(), {
      coalesceWindowMs: 60_000,
    });
    const original = h;
    const replay = await replayServiceCurrentDoc(
      original.http.service,
      original.documentId,
      original.operator
    );
    if (!replay.incarnation) throw new Error('Original native birth missing.');
    const generation = replay.incarnation.generation;
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const submit = async (
      actual: NonNullable<typeof h> | (typeof successors)[number],
      id: string,
      text: string
    ) => {
      const result = await submitCurrentDocEvent(
        actual.http.service,
        original.documentId,
        { v: 1, id, type: 'md.comment', payload: { text } },
        original.operator,
        { expectedGeneration: generation }
      );
      expect(result.receipt).toMatchObject({ id, status: 'recorded' });
    };
    const batch = (actual: NonNullable<typeof h> | (typeof successors)[number]) =>
      actual.db.get<Record<string, unknown>>(
        sql`SELECT * FROM canvas_doc_batches WHERE document_id=${original.documentId}`
      )!;
    const capsule = (actual: NonNullable<typeof h> | (typeof successors)[number]) =>
      actual.db.get<Record<string, unknown>>(
        sql`SELECT * FROM canvas_doc_room_pending_sources WHERE document_id=${original.documentId}`
      )!;
    const noAdmission = (actual: NonNullable<typeof h> | (typeof successors)[number]) => {
      expect(
        actual.db.get<{ count: number }>(sql`SELECT count(*) AS count FROM room_doc_admissions`)!
          .count
      ).toBe(0);
      expect(
        actual.db.get<{ count: number }>(
          sql`SELECT count(*) AS count FROM session_message_acceptance_receipts`
        )!.count
      ).toBe(0);
    };
    await submit(original, ids[0], 'first original');
    await submit(original, ids[1], 'second original');
    const before = batch(original),
      beforeCapsule = capsule(original);
    expect(before.status).toBe('pending');
    expect(JSON.parse(String(before.input_event_ids))).toEqual(ids.slice(0, 2));
    for (const key of [
      'delivery_kind',
      'admission_receipt_id',
      'room_admission_id',
      'room_source_attempt',
      'room_source_json',
      'room_source_hash',
    ])
      expect(before[key]).toBeNull();
    expect(beforeCapsule).toMatchObject({
      batch_id: before.batch_id,
      generation: before.generation,
      due_at: before.due_at,
    });
    noAdmission(original);
    await closeNative(original);
    const successor = await reopenNativeRoomAuthorityFixture(original);
    successors.push(successor);
    // Wake performs original constructor recovery; the original deadline is still in the future.
    const due = currentRoomDueServicePort(successor.http.service);
    due.wake();
    expect(due.nextDueAt()).toBe(before.due_at);
    expect(batch(successor)).toEqual(before);
    expect(capsule(successor)).toEqual(beforeCapsule);
    await submit(successor, ids[2], 'third original');
    const coalesced = batch(successor),
      coalescedCapsule = capsule(successor);
    expect(coalesced).toMatchObject({
      batch_id: before.batch_id,
      generation: before.generation,
      due_at: before.due_at,
      status: 'pending',
    });
    expect(JSON.parse(String(coalesced.input_event_ids))).toEqual(ids);
    expect(coalescedCapsule.source_json).not.toBe(beforeCapsule.source_json);
    expect(
      JSON.parse(String(coalescedCapsule.source_json)).durableSource.inputs.map(
        (input: { eventId: string }) => input.eventId
      )
    ).toEqual(ids);
    noAdmission(successor);
    const protectedBytes = successor.db.get<{ bytes: number }>(
      protectedCapacityQuery(original.documentId)
    )!.bytes;
    const eventBytes = successor.db.get<{ bytes: number }>(
      sql`SELECT sum(envelope_bytes) AS bytes FROM canvas_doc_events WHERE document_id=${original.documentId} AND direction='upstream'`
    )!.bytes;
    expect(protectedBytes).toBe(
      eventBytes + Buffer.byteLength(String(coalescedCapsule.source_json), 'utf8')
    );
    const eventsBefore = successor.db.all(
      sql`SELECT * FROM canvas_doc_events WHERE document_id=${original.documentId} AND direction='upstream' ORDER BY doc_seq`
    );
    // Original constructor clock seam derives exactly the production 24h boundary from the accepted route's firstAt.
    const firstAt = Date.parse(String(coalesced.due_at)) - 60_000;
    const now = () => new Date(firstAt + 24 * 3_600_000);
    const admission = new DocBatchAdmission({
      db: successor.db,
      store: successor.http.channels,
      grants: successor.http.grants,
      lifecycle: new DocChannelLifecycle(successor.db),
      queue: new MessageQueueStore(successor.db),
      bootEpoch: randomUUID(),
      beforeClaim: privateDocTurnBudget,
      now,
    });
    const pump = new DocBatchDeliveryPump({
      db: successor.db,
      store: successor.http.channels,
      grants: successor.http.grants,
      admission,
      now,
      ...createPrivateDocPumpGates({
        grants: successor.http.grants,
        runtimes: new RuntimeRegistry(),
        now,
      }),
      markWaitingWarning: (id, gen, at, tx) =>
        successor.http.channels.markWaitingWarning(id, gen, at, tx),
      nudge: () => {
        throw new Error('Expired original work must not dispatch.');
      },
    });
    expect(pump.run()).toMatchObject({ expired: 1, admitted: 0, waiting: 0, cancelled: 0 });
    expect(batch(successor).status).toBe('expired');
    noAdmission(successor);
    expect(
      successor.db.get<{ bytes: number }>(protectedCapacityQuery(original.documentId))!.bytes
    ).toBe(0);
    await closeNative(successor);
    const next = await reopenNativeRoomAuthorityFixture(original);
    successors.push(next);
    currentRoomDueServicePort(next.http.service).wake();
    expect(batch(next).status).toBe('expired');
    noAdmission(next);
    expect(capsule(next)).toEqual(coalescedCapsule);
    const reviewed = await replayServiceOriginalExpiredDocBatch(
      next.http.service,
      {
        documentId: original.documentId,
        expectedGeneration: generation,
        eventId: randomUUID(),
        batchId: String(coalesced.batch_id),
        expectedBatchGeneration: String(coalesced.generation),
        grantId: original.granted.grant.grantId,
      },
      original.operator
    );
    expect(reviewed.previousBatchId).toBe(coalesced.batch_id);
    expect(reviewed.batchId).not.toBe(coalesced.batch_id);
    expect(reviewed.generation).not.toBe(coalesced.generation);
    expect(
      next.db.all(
        sql`SELECT * FROM canvas_doc_events WHERE document_id=${original.documentId} AND direction='upstream' ORDER BY doc_seq`
      )
    ).toEqual(eventsBefore);
    const fresh = next.db.get<Record<string, unknown>>(
      sql`SELECT * FROM canvas_doc_batches WHERE batch_id=${reviewed.batchId}`
    )!;
    expect(JSON.parse(String(fresh.input_event_ids))).toEqual(ids);
    expect(fresh.status).toBe('accepted');
    expect(fresh.admission_receipt_id).toBeNull();
    noAdmission(next);
    expect(
      next.db.get(
        sql`SELECT * FROM canvas_doc_room_pending_sources WHERE batch_id=${reviewed.batchId}`
      )
    ).toBeUndefined();
    retainDocHistory(next.http.channels, new Date().toISOString());
    // Original orphan-batch pruning owns the FK-cascaded historical capsule, with no new retention policy.
    expect(
      next.db.get(
        sql`SELECT * FROM canvas_doc_room_pending_sources WHERE batch_id=${coalesced.batch_id}`
      )
    ).toBeUndefined();
    expect(
      next.db.all(
        sql`SELECT * FROM canvas_doc_events WHERE document_id=${original.documentId} AND direction='upstream' ORDER BY doc_seq`
      )
    ).toEqual(eventsBefore);
  } catch (cause) {
    remember(cause);
  }
  let cleanupFailed = false;
  for (const actual of successors.reverse()) {
    try {
      await actual.cleanup();
    } catch (cause) {
      cleanupFailed = true;
      remember(cause);
    }
  }
  if (h && !cleanupFailed) {
    try {
      await h.cleanup();
      allClosed = true;
    } catch (cause) {
      remember(cause);
    }
  }
  if (allClosed) {
    try {
      await fs.rm(root, { recursive: true, force: true });
    } catch (cause) {
      remember(cause);
    }
  }
  if (failed) throw first;
});
