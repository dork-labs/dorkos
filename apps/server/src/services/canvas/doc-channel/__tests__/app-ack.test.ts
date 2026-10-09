import { protectedEventSql, retainedRoomEventSql } from '../current/accounting.js';
import { CanvasChannelManagementSnapshotSchema } from '@dorkos/shared/canvas-channel-schemas';
import { retainDocHistory } from '../retention.js';
import {
  createOriginalDocManagementReader,
  projectDocManagementRows,
} from '../management/snapshot-data.js';
/** Correlated acknowledgments require actual exact route approval and current responder identity. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { agents, sessionMetadata, eq, sql } from '@dorkos/db';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { replayDocChannel } from '../replay.js';
import { actor, send, ackFixture } from './downstream-fixtures.js';
import { NOW, FROM } from './lifecycle-fixtures.js';
describe('exact approved target application acknowledgments', () => {
  it('refuses an authenticated target-shaped principal belonging to another installation', async () => {
    const f = ackFixture();
    const claims = f.responder.principal.claims;
    const outsider = {
      ...f.responder,
      principal: createServerPrincipal({
        ...claims,
        owner: { kind: 'local_install', installationId: 'another-installation' },
      }),
    };
    await expect(f.service.send(f.ack(), outsider)).rejects.toMatchObject({ status: 404 });
    expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]!.ackOutcome).toBeNull();
  });
  it('allows a granted responder without owning-session access, keeps turn_done unfulfilled, and settles only named inputs', async () => {
    const f = ackFixture();
    await expect(f.authorization.require(f.doc.id, f.responder, true)).rejects.toMatchObject({
      status: 404,
    });
    expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]!.ackOutcome).toBeNull();
    const input = f.ack();
    const first = await f.service.send(input, f.responder);
    expect(await f.service.send(input, f.responder)).toEqual({
      receipt: { ...first.receipt, status: 'duplicate' },
    });
    expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]).toMatchObject({
      status: 'turn_done',
      ackOutcome: 'handled',
      ackEvidence: { generation: 'generation', grantId: f.grant.grantId },
    });
    expect(f.store.listDeliveries(f.doc.id, f.ids[1]!)[0]!.ackOutcome).toBeNull();
    await f.service.send(f.ack([f.ids[1]!], 'rejected'), f.responder);
    const snapshot = replayDocChannel(f.store, () => ({
      documentId: f.doc.id,
      scope: FROM,
      documentLabel: 'doc',
      provenance: {},
      routes: [],
    }));
    expect(snapshot.receipts.find((row) => row.id === f.ids[1])!.deliveries[0]!.ackOutcome).toBe(
      'rejected'
    );
    expect(f.store.getBatch('batch')!.status).toBe('turn_done');
    expect(f.queue.list('target-session')).toHaveLength(0);
  });
  it('rejects mixed invalid IDs, duplicate IDs, wrong routes and unrelated writers without a partial ack', async () => {
    const f = ackFixture();
    for (const input of [
      f.ack([f.ids[0]!, randomUUID()]),
      f.ack([f.ids[0]!, f.ids[0]!]),
      {
        ...f.ack(),
        payload: { batchId: 'batch', routeId: 'wrong', eventIds: [f.ids[0]], outcome: 'handled' },
      },
    ])
      await expect(f.service.send(input, f.responder)).rejects.toThrow();
    await expect(f.service.send(f.ack(), actor())).rejects.toMatchObject({ status: 404 });
    expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]!.ackOutcome).toBeNull();
    expect(f.store.getChannel(f.doc.id)!.nextDocSeq).toBe(3);
  });
  it('rejects frozen-path relocation, revoked grants, and closure even for an already recorded duplicate', async () => {
    const f = ackFixture();
    const input = f.ack();
    await f.service.send(input, f.responder);
    f.db.update(agents).set({ projectPath: '/agents/moved' }).where(eq(agents.id, 'target')).run();
    f.db
      .update(sessionMetadata)
      .set({ agentPath: '/agents/moved' })
      .where(eq(sessionMetadata.sessionId, 'target-session'))
      .run();
    await expect(
      f.service.send(input, actor('target', 'target-session', '/agents/moved'))
    ).rejects.toThrow('TARGET_IDENTITY_CHANGED');
    f.db.update(agents).set({ projectPath: '/agents/target' }).where(eq(agents.id, 'target')).run();
    f.db
      .update(sessionMetadata)
      .set({ agentPath: '/agents/target' })
      .where(eq(sessionMetadata.sessionId, 'target-session'))
      .run();
    f.grants.revoke(f.doc.id, f.grant.grantId, actor());
    await expect(f.service.send(input, f.responder)).rejects.toThrow('GRANT_REVOKED');
    f.store.markClosed(f.doc.id, NOW, { reason: 'test closure' });
    await expect(f.service.send(input, f.responder)).rejects.toThrow();
  });
  it('rechecks revocation after asynchronous preparation and refuses generic writes from the narrow responder', async () => {
    let revokeAfterRevalidation = false;
    const f = ackFixture(() => {
      if (revokeAfterRevalidation) f.grants.revoke(f.doc.id, f.grant.grantId, actor());
    });
    await expect(f.service.send(send(f.doc.id), f.responder)).rejects.toMatchObject({
      status: 404,
    });
    revokeAfterRevalidation = true;
    await expect(f.service.send(f.ack(), f.responder)).rejects.toThrow('GRANT_REVOKED');
    expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]!.ackOutcome).toBeNull();
  });
  it('refuses changed downstream IDs and conflicting later acknowledgments without erasing original evidence', async () => {
    const f = ackFixture();
    const input = f.ack();
    await f.service.send(input, f.responder);
    await expect(
      f.service.send({ ...input, payload: { ...input.payload, outcome: 'rejected' } }, f.responder)
    ).rejects.toMatchObject({ status: 409 });
    await expect(f.service.send(f.ack([f.ids[0]!], 'rejected'), f.responder)).rejects.toMatchObject(
      { status: 409 }
    );
    expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]).toMatchObject({
      ackOutcome: 'handled',
      ackEvidence: { downstreamEventId: input.eventId },
    });
  });
  it('rolls back per-input evidence when the downstream event cannot be persisted', async () => {
    const f = ackFixture();
    f.db.$client.exec(
      "CREATE TRIGGER fail_ack BEFORE INSERT ON canvas_doc_events WHEN NEW.direction='downstream' BEGIN SELECT RAISE(ABORT,'injected ack failure'); END"
    );
    await expect(f.service.send(f.ack(), f.responder)).rejects.toMatchObject({ status: 507 });
    expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]).toMatchObject({
      ackOutcome: null,
      acknowledgedAt: null,
      ackEvidence: null,
    });
    expect(f.store.getChannel(f.doc.id)!.nextDocSeq).toBe(3);
  });
  it('explicitly refuses room responses without an admitted responder proof and pending batches', async () => {
    const f = ackFixture();
    f.db.run(sql`UPDATE canvas_doc_batches SET status='pending' WHERE batch_id='batch'`);
    await expect(f.service.send(f.ack(), f.responder)).rejects.toMatchObject({ status: 404 });
    f.db.run(sql`UPDATE canvas_doc_batches SET status='turn_done' WHERE batch_id='batch'`);
    const original = f.grants.revalidateBatchGrant.bind(f.grants);
    vi.spyOn(f.grants, 'revalidateBatchGrant').mockImplementation((...args) => {
      const checked = original(...args);
      return { ...checked, target: { ...checked.target, scope: 'room:local-room' } };
    });
    await expect(f.service.send(f.ack(), f.responder)).rejects.toMatchObject({
      code: 'ROOM_APP_ACK_RESPONDER_UNAVAILABLE',
      status: 409,
    });
    expect(f.store.listDeliveries(f.doc.id, f.ids[0]!)[0]!.ackOutcome).toBeNull();
  });
});

it('projects only actual original per-input ACK evidence and keeps completed unacknowledged inputs distinct', async () => {
  const f = ackFixture();
  // This older helper seeds a literal generation; this DATA projection control uses the current wire UUID.
  f.db.run(sql`UPDATE canvas_doc_batches SET generation=${randomUUID()} WHERE batch_id='batch'`);
  const reader = createOriginalDocManagementReader(f.db);
  const inspect = () =>
    f.db.$client.transaction(() =>
      CanvasChannelManagementSnapshotSchema.shape.reviews
        .parse(projectDocManagementRows(reader(f.doc.id)).reviews)
        .map((review) => {
          const inputs = review.inputs;
          if (!inputs) throw new Error('Original management input projection unavailable.');
          return { ...review, inputs };
        })
    )();
  const before = inspect().find((review) => review.batchId === 'batch')!;
  expect(before.status).toBe('turn_done');
  expect(before.inputs).toHaveLength(2);
  expect(
    before.inputs.every((input) => input.ackOutcome === null && input.acknowledgedAt === null)
  ).toBe(true);
  const handled = await f.service.send(f.ack(), f.responder);
  const partial = inspect().find((review) => review.batchId === 'batch')!;
  expect(partial.inputs.find((input) => input.eventId === f.ids[0])).toMatchObject({
    ackOutcome: 'handled',
    ackEvidenceStatus: 'verified',
    status: 'turn_done',
  });
  expect(partial.inputs.find((input) => input.eventId === f.ids[1])).toMatchObject({
    ackOutcome: null,
    acknowledgedAt: null,
    status: 'turn_done',
  });
  expect(partial.inputsTruncated).toBe(false);
  for (const input of partial.inputs) {
    for (const rawField of [
      'ackEvidence',
      'acknowledgedBy',
      'ackDirection',
      'ackType',
      'ackPayload',
      'ackProvenance',
      'ackReceivedAt',
      'ackPrunedAt',
    ])
      expect(input).not.toHaveProperty(rawField);
    expect(input).toHaveProperty('ackEvidenceStatus');
  }
  const rejected = await f.service.send(f.ack([f.ids[1]!], 'rejected'), f.responder);
  expect(inspect()[0]!.inputs.find((input) => input.eventId === f.ids[1])!.ackOutcome).toBe(
    'rejected'
  );
  f.db.$client
    .prepare('DELETE FROM canvas_doc_events WHERE document_id=? AND event_id=?')
    .run(f.doc.id, handled.receipt.id);
  expect(inspect()[0]!.inputs.find((input) => input.eventId === f.ids[0])!.ackEvidenceStatus).toBe(
    'unavailable'
  );
  f.db.$client
    .prepare('UPDATE canvas_doc_events SET payload=? WHERE document_id=? AND event_id=?')
    .run(
      JSON.stringify({
        batchId: 'batch',
        routeId: 'route',
        eventIds: [f.ids[0]],
        outcome: 'rejected',
      }),
      f.doc.id,
      rejected.receipt.id
    );
  expect(inspect).toThrow('Foreign original acknowledgement event.');
  f.db.$client
    .prepare('UPDATE canvas_doc_events SET payload=? WHERE document_id=? AND event_id=?')
    .run(
      JSON.stringify({
        batchId: 'batch',
        routeId: 'route',
        eventIds: [f.ids[1]],
        outcome: 'rejected',
      }),
      f.doc.id,
      rejected.receipt.id
    );
  // Fresh SQL is mandatory on every projection; incomplete persisted ACK metadata cannot imply handling.
  f.db.$client
    .prepare(
      'UPDATE canvas_doc_deliveries SET acknowledged_at=NULL WHERE document_id=? AND event_id=?'
    )
    .run(f.doc.id, f.ids[0]);
  expect(inspect).toThrow('Incomplete original acknowledgement evidence.');
});

it('projects a genuinely payload-pruned retained ACK header as unavailable without erasing protected input outcomes', async () => {
  const f = ackFixture();
  // This older helper seeds a literal generation; this DATA projection control uses the current wire UUID.
  f.db.run(sql`UPDATE canvas_doc_batches SET generation=${randomUUID()} WHERE batch_id='batch'`);
  const ack = await f.service.send(f.ack(), f.responder);
  // Actual unresolved batch protection retains both inputs; only the downstream ACK is compactable.
  f.db.run(sql`UPDATE canvas_doc_batches SET status='in_doubt' WHERE batch_id='batch'`);
  // Match the actual retention document-usage formula, rather than guessing the ACK's share.
  for (const table of [
    'room_doc_admissions',
    'room_doc_admission_inputs',
    'room_doc_exhausted_lineages',
  ])
    expect(
      f.db.$client
        .prepare<unknown[], { count: number }>(`SELECT count(*) AS count FROM ${table}`)
        .get()!.count
    ).toBe(0);
  const rowBytes = (alias: string, columns: readonly string[]) =>
    sql.raw(
      `length(CAST(json_object(${columns.map((name) => `'${name}',${alias}.${name}`).join(',')}) AS BLOB))`
    );
  const eventBytes = rowBytes('e', [
    'document_id',
    'event_id',
    'doc_seq',
    'direction',
    'type',
    'payload',
    'envelope_hash',
    'envelope_bytes',
    'payload_pruned_at',
    'coalesce_key',
    'client_ts',
    'received_at',
    'provenance',
  ]);
  const deliveryBytes = rowBytes('d', [
    'document_id',
    'event_id',
    'route_id',
    'batch_id',
    'status',
    'turn_id',
    'reason',
    'ack_outcome',
    'acknowledged_at',
    'acknowledged_by',
    'ack_evidence',
    'updated_at',
    'delivery_kind',
    'room_admission_id',
  ]);
  const batchBytes = rowBytes('b', [
    'batch_id',
    'document_id',
    'scope',
    'route_id',
    'grant_id',
    'grant_revision',
    'generation',
    'input_event_ids',
    'effective_payload',
    'due_at',
    'status',
    'attempt',
    'lease_until',
    'relay_message_id',
    'turn_id',
    'admission_receipt_id',
    'error_code',
    'waiting_warning_at',
    'created_at',
    'updated_at',
    'delivery_kind',
    'room_admission_id',
    'room_source_attempt',
    'room_source_json',
    'room_source_hash',
  ]);
  const usage = f.db.get<{ bytes: number }>(sql`SELECT
    (SELECT coalesce(sum(${eventBytes} + coalesce((SELECT sum(${deliveryBytes}) FROM canvas_doc_deliveries d
      WHERE d.document_id=e.document_id AND d.event_id=e.event_id),0)),0)
      FROM canvas_doc_events e WHERE e.document_id=${f.doc.id} AND (NOT ${protectedEventSql} OR ${retainedRoomEventSql})) +
    (SELECT coalesce(sum(${batchBytes}),0) FROM canvas_doc_batches b WHERE b.document_id=${f.doc.id} AND
      (b.status NOT IN ('pending','waiting','accepted','dispatching','turn_started','in_doubt') OR
       EXISTS (SELECT 1 FROM room_doc_admissions ra WHERE ra.document_id=b.document_id AND ra.batch_id=b.batch_id))) AS bytes`)!;
  expect(usage.bytes).toBeGreaterThan(1);
  retainDocHistory(f.store, NOW, { documentBytes: usage.bytes - 1 });
  expect(f.store.getEvent(f.doc.id, ack.receipt.id)).toMatchObject({
    payload: null,
    provenance: {},
    payloadPrunedAt: NOW,
  });
  const read = createOriginalDocManagementReader(f.db);
  const inspect = () =>
    f.db.$client.transaction(() =>
      CanvasChannelManagementSnapshotSchema.shape.reviews
        .parse(projectDocManagementRows(read(f.doc.id)).reviews)
        .map((review) => {
          const inputs = review.inputs;
          if (!inputs) throw new Error('Original management input projection unavailable.');
          return { ...review, inputs };
        })
    )();
  const review = inspect().find((row) => row.batchId === 'batch')!;
  expect(review.inputs.find((input) => input.eventId === f.ids[0])).toMatchObject({
    ackOutcome: 'handled',
    ackEvidenceStatus: 'unavailable',
  });
  expect(review.inputs.find((input) => input.eventId === f.ids[1])).toMatchObject({
    ackOutcome: null,
    ackEvidenceStatus: 'none',
  });
  expect(review.inputsTruncated).toBe(false);
  f.db.$client
    .prepare('UPDATE canvas_doc_events SET provenance=? WHERE document_id=? AND event_id=?')
    .run('{"foreign":true}', f.doc.id, ack.receipt.id);
  expect(inspect).toThrow('Invalid pruned original acknowledgement header.');
});
