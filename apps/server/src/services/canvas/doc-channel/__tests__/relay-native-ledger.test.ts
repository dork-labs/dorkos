import { CanvasChannelGrantSchema } from '@dorkos/shared/canvas-channel-schemas';
/** Original migrated SQLite native sibling/CAS controls. No SDK/process or live principal acceptance claim. */
import { afterEach, expect, it } from 'vitest';
import {
  connectorRuntimeBindings,
  canvasDocDeliveries,
  canvasDocChannels,
  sessionMessageAcceptanceReceipts,
  eq,
} from '@dorkos/db';
import { nativeRelayFixture, NOW } from './relay-native-fixture.js';
const opened: ReturnType<typeof nativeRelayFixture>[] = [];
afterEach(() => {
  for (const f of opened) {
    f.native.requireClosed();
    f.db.$client.close();
  }
  opened.length = 0;
});
function fixture() {
  const f = nativeRelayFixture();
  opened.push(f);
  f.db
    .insert(connectorRuntimeBindings)
    .values({
      id: 'native-binding',
      tokenHash: 'native-fixture-token-hash',
      bootEpoch: 'native-fixture',
      ownerKind: 'local_install',
      ownerId: 'installation',
      runtime: 'claude-code',
      canonicalSessionId: 'session-1',
      agentId: 'agent-1',
      agentPath: '/agents/one',
      canonicalCwd: '/agents/one',
      createdAt: NOW,
      expiresAt: '2026-10-02T00:00:00.000Z',
    })
    .run();
  f.input({ checked: true });
  f.input({ checked: false });
  const id = f.batchId();
  f.admission.admit(id);
  const batch = f.store.getBatch(id)!,
    grant = f.store.getGrant(f.grantId)!;
  const receipt = f.db
    .select()
    .from(sessionMessageAcceptanceReceipts)
    .where(eq(sessionMessageAcceptanceReceipts.id, batch.admissionReceiptId!))
    .get()!;
  const selector = {
    batchId: id,
    generation: batch.generation,
    documentId: f.documentId,
    routeId: batch.routeId,
    scope: batch.scope,
    grantId: grant.grantId,
    grantRevision: grant.revision,
    sessionId: receipt.sessionId,
    agentId: receipt.agentId,
    runtime: receipt.originRuntime,
    agentPath: receipt.originAgentPath,
    authorityDigest: receipt.originAuthorityDigest,
  };
  const capture = () => f.native.capture(selector, NOW);
  const claim = () =>
    f.native.claim(
      capture(),
      NOW,
      CanvasChannelGrantSchema.shape.limits.parse(grant.limits).turnsPerHour,
      'native-binding',
      7
    );
  const rows = (table: string) =>
    f.db.$client
      .prepare('SELECT * FROM ' + table + ' WHERE document_id=? ORDER BY rowid')
      .all(f.documentId);
  return { f, batch, receipt, capture, claim, rows };
}
it('original native claim removes exactly the queue row, charges once and terminal settlement preserves actual acknowledgement', () => {
  const { f, batch, receipt, claim, rows } = fixture();
  const priorEvents = rows('canvas_doc_events') as Record<string, unknown>[];
  const token = claim();
  expect(
    f.db.$client
      .prepare('SELECT count(*) n FROM session_message_queue WHERE id=?')
      .get(receipt.queueMessageId)
  ).toEqual({ n: 0 });
  expect(f.store.getBatch(batch.batchId)).toMatchObject({
    status: 'turn_started',
    attempt: 1,
    turnId: `projected:${receipt.id}:7`,
  });
  expect(
    f.db.$client
      .prepare(
        "SELECT count(*) n FROM session_message_acceptance_receipts WHERE source_kind='document_event_batch' AND source_id=? AND dispatch_claimed_at=?"
      )
      .get(batch.batchId, NOW)
  ).toEqual({ n: 1 });
  const deliveries = f.db
    .select()
    .from(canvasDocDeliveries)
    .where(eq(canvasDocDeliveries.documentId, f.documentId))
    .all();
  expect(deliveries).toHaveLength(2);
  f.db
    .update(canvasDocDeliveries)
    .set({
      ackOutcome: 'handled',
      ackEvidence: { nativeFixture: true },
      acknowledgedAt: NOW,
      acknowledgedBy: 'agent-1',
    })
    .where(eq(canvasDocDeliveries.eventId, deliveries[0]!.eventId))
    .run();
  const before = rows('canvas_doc_deliveries') as Record<string, unknown>[];
  const hint = f.native.settle(token, '2026-10-01T12:00:01.000Z', 'completed');
  f.native.requireClosed();
  expect(hint).toMatchObject({ documentId: f.documentId, type: 'event.status' });
  expect(f.store.getBatch(batch.batchId)).toMatchObject({ status: 'turn_done', attempt: 1 });
  expect(rows('canvas_doc_deliveries')).toEqual(
    before.map((row) => ({ ...row, status: 'turn_done', updated_at: '2026-10-01T12:00:01.000Z' }))
  );
  expect(
    f.db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(eq(sessionMessageAcceptanceReceipts.id, receipt.id))
      .get()
  ).toMatchObject({ state: 'settled', turnStartSeq: 7, settleOutcome: 'completed' });
  const allEvents = rows('canvas_doc_events') as Record<string, unknown>[];
  expect(allEvents.slice(0, priorEvents.length)).toEqual(priorEvents);
  const statuses = allEvents.slice(priorEvents.length);
  expect(statuses).toHaveLength(2);
  expect(statuses.filter((row) => row.type === 'event.status')).toHaveLength(2);
  expect(
    statuses
      .filter((row) => row.type === 'event.status')
      .map((row) => JSON.parse(String(row.provenance)))
  ).toEqual([{ source: 'doc-channel-service' }, { source: 'doc-channel-service' }]);
  expect(() => f.native.settle(token, '2026-10-01T12:00:02.000Z', 'completed')).toThrow(
    'settlement claim unavailable'
  );
});
it('native terminal trigger mutation rolls back receipt, batch, acknowledgement and status append together', () => {
  const { f, receipt, claim, rows } = fixture();
  const token = claim();
  const before = {
    batches: rows('canvas_doc_batches'),
    deliveries: rows('canvas_doc_deliveries'),
    events: rows('canvas_doc_events'),
    receipt: f.db.$client
      .prepare('SELECT * FROM session_message_acceptance_receipts WHERE id=?')
      .get(receipt.id),
  };
  f.db.$client.exec(
    "CREATE TRIGGER relay_terminal_fault AFTER UPDATE OF status ON canvas_doc_batches WHEN NEW.status='turn_done' BEGIN UPDATE canvas_doc_deliveries SET ack_evidence='{}' WHERE batch_id=NEW.batch_id; END"
  );
  expect(() => f.native.settle(token, '2026-10-01T12:00:01.000Z', 'completed')).toThrow(
    'ledger/ack/queue changed'
  );
  f.native.requireClosed();
  expect({
    batches: rows('canvas_doc_batches'),
    deliveries: rows('canvas_doc_deliveries'),
    events: rows('canvas_doc_events'),
    receipt: f.db.$client
      .prepare('SELECT * FROM session_message_acceptance_receipts WHERE id=?')
      .get(receipt.id),
  }).toEqual(before);
});
it('changed original accepted source refuses the consumed prepared facts without claim or queue removal', () => {
  const { f, receipt, capture } = fixture();
  const facts = capture();
  f.db
    .update(canvasDocChannels)
    .set({ closedAt: NOW })
    .where(eq(canvasDocChannels.documentId, f.documentId))
    .run();
  expect(() => f.native.claim(facts, NOW, 10, 'native-binding', 7)).toThrow(
    'grant/channel changed'
  );
  f.native.requireClosed();
  expect(
    f.db.$client
      .prepare('SELECT count(*) n FROM session_message_queue WHERE id=?')
      .get(receipt.queueMessageId)
  ).toEqual({ n: 1 });
  expect(() => f.native.claim(facts, NOW, 10, 'native-binding', 7)).toThrow('facts required');
});
it('closed channel settlement retains its tombstone and appends no terminal status event', () => {
  const { f, claim, rows } = fixture();
  const token = claim();
  f.db
    .update(canvasDocChannels)
    .set({ closedAt: NOW })
    .where(eq(canvasDocChannels.documentId, f.documentId))
    .run();
  const events = rows('canvas_doc_events');
  expect(f.native.settle(token, '2026-10-01T12:00:01.000Z', 'failed')).toBeUndefined();
  f.native.requireClosed();
  expect(rows('canvas_doc_events')).toEqual(events);
  expect(f.store.getChannel(f.documentId)?.closedAt).toBe(NOW);
});
