import { CanvasChannelGrantSchema } from '@dorkos/shared/canvas-channel-schemas';
/** Cross-target original migrated SQLite native claim/CAS controls; SDK dispatch is covered separately. */
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocBatchAdmission } from '../delivery/batch-admission.js';
import { CanvasDocumentStore } from '../../canvas-document-store.js';
import { documentRouteTurnBudget } from '../delivery/final-budget.js';
import {
  connectorRuntimeBindings,
  sessionMetadata,
  canvasDocDeliveries,
  canvasDocChannels,
  sessionMessageAcceptanceReceipts,
  eq,
} from '@dorkos/db';
import { nativeRelayFixture, NOW } from './relay-native-fixture.js';
const opened: ReturnType<typeof nativeRelayFixture>[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const f of opened) {
    f.native.requireClosed();
    f.db.$client.close();
  }
  opened.length = 0;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'doc-cross-target-native-'));
  directories.push(directory);
  const f = nativeRelayFixture(join(directory, 'db.sqlite'), null, 'boot-1', 'claude-code', {
    targetAgentPath: '/agents/two',
    nativeLedgerOnly: true,
  });
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
      canonicalSessionId: 'other-session',
      agentId: 'agent-2',
      agentPath: '/agents/two',
      canonicalCwd: '/agents/two',
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
  expect(batch.scope).toBe('session:session-1');
  expect(receipt).toMatchObject({
    sessionId: 'other-session',
    agentId: 'agent-2',
    originAgentPath: '/agents/two',
  });
  expect(grant.approvalId).not.toBeNull();
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
      acknowledgedBy: 'agent-2',
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

it('restart before native claim preserves the same other-agent receipt without duplicating its queue row', () => {
  const { f, batch, receipt } = fixture();
  const before = f.db.$client
    .prepare('SELECT * FROM session_message_acceptance_receipts WHERE id=?')
    .get(receipt.id);
  // Reconstruct the original persisted document/lifecycle owner for this boot.
  // The previous live owner's receipt coordinator must never be replaced.
  const restartedDocuments = new CanvasDocumentStore(f.db, { now: () => NOW });
  expect(restartedDocuments.lifecycle).not.toBe(f.documents.lifecycle);
  const restarted = new DocBatchAdmission({
    db: f.db,
    store: f.store,
    grants: f.grants,
    lifecycle: restartedDocuments.lifecycle,
    queue: f.queue,
    bootEpoch: 'new-native-boot',
    beforeClaim: documentRouteTurnBudget,
    now: () => new Date(NOW),
  });
  expect(restarted.initializeBoot()).toBe(0);
  const accepted = restarted.admit(batch.batchId);
  expect(accepted.receipt.id).toBe(receipt.id);
  expect(
    f.db.$client
      .prepare('SELECT * FROM session_message_acceptance_receipts WHERE id=?')
      .get(receipt.id)
  ).toEqual(before);
  expect(f.queue.list('other-session')).toHaveLength(1);
  expect(f.queue.list('session-1')).toEqual([]);
});
it('restart after other-agent FIRST quarantines the same native attempt and cannot admit a second turn', () => {
  const { f, batch, receipt, claim } = fixture();
  const token = claim();
  // FIRST committed the genuine native frame; this fixture allocated no SDK child.
  f.native.requireClosed();
  // Reconstruct the original persisted document/lifecycle owner for this boot.
  // The previous live owner's receipt coordinator must never be replaced.
  const restartedDocuments = new CanvasDocumentStore(f.db, { now: () => NOW });
  expect(restartedDocuments.lifecycle).not.toBe(f.documents.lifecycle);
  const restarted = new DocBatchAdmission({
    db: f.db,
    store: f.store,
    grants: f.grants,
    lifecycle: restartedDocuments.lifecycle,
    queue: f.queue,
    bootEpoch: 'new-native-boot',
    beforeClaim: documentRouteTurnBudget,
    now: () => new Date(NOW),
  });
  expect(restarted.initializeBoot()).toBe(1);
  expect(
    f.db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(eq(sessionMessageAcceptanceReceipts.id, receipt.id))
      .get()
  ).toMatchObject({
    state: 'outcome_unknown',
    cancellationCode: 'server_restarted_after_dispatch_claim',
    agentId: 'agent-2',
  });
  expect(f.store.getBatch(batch.batchId)).toMatchObject({ status: 'in_doubt', attempt: 1 });
  expect(f.queue.list('other-session')).toEqual([]);
  expect(() => restarted.admit(batch.batchId)).toThrow();
  expect(() => f.native.settle(token, NOW, 'completed')).toThrow();
  f.native.requireClosed();
});
it('another receipt or copied token cannot settle a claimed other-agent batch', () => {
  const { f, batch, receipt, claim } = fixture();
  const token = claim();
  const before = f.store.getBatch(batch.batchId);
  expect(() =>
    f.native.settle(
      Object.freeze({ ...token, receiptId: receipt.id, sessionId: 'session-1' }),
      NOW,
      'completed'
    )
  ).toThrow('Original Relay settlement claim unavailable');
  expect(f.store.getBatch(batch.batchId)).toEqual(before);
  expect(
    f.db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(eq(sessionMessageAcceptanceReceipts.id, receipt.id))
      .get()?.state
  ).toBe('turn_started');
  f.native.settle(token, '2026-10-01T12:00:01.000Z', 'completed');
  f.native.requireClosed();
});

it('moving the owning session rebinds the source digest without moving the approved other-agent target', async () => {
  const { f, batch, receipt } = fixture();
  const before = f.db
    .select()
    .from(sessionMessageAcceptanceReceipts)
    .where(eq(sessionMessageAcceptanceReceipts.id, receipt.id))
    .get()!;
  expect(f.documents.rekeyScope('session:session-1', 'session:canonical')).toBe(1);
  const after = f.db
    .select()
    .from(sessionMessageAcceptanceReceipts)
    .where(eq(sessionMessageAcceptanceReceipts.id, receipt.id))
    .get()!;
  expect(after).toEqual({ ...before, originAuthorityDigest: after.originAuthorityDigest });
  expect(after.originAuthorityDigest).not.toBe(before.originAuthorityDigest);
  expect(after).toMatchObject({
    sessionId: 'other-session',
    agentId: 'agent-2',
    state: 'accepted',
  });
  expect(f.store.getBatch(batch.batchId)).toMatchObject({
    scope: 'session:canonical',
    admissionReceiptId: receipt.id,
    generation: batch.generation,
  });
  expect(f.store.getGrant(f.grantId)?.targetSessionId).toBe('other-session');
  expect(f.queue.list('other-session')).toHaveLength(1);
  await expect(f.admission.acceptance.prepare(receipt.id)).resolves.toBeDefined();
});
it('moving only the approved target preserves source scope and rebinds the same accepted target receipt and queue', async () => {
  const { f, batch, receipt } = fixture();
  f.db
    .insert(sessionMetadata)
    .values({
      sessionId: 'other-canonical',
      runtime: 'claude-code',
      agentPath: '/agents/two',
      createdAt: NOW,
    })
    .run();
  const before = f.db
    .select()
    .from(sessionMessageAcceptanceReceipts)
    .where(eq(sessionMessageAcceptanceReceipts.id, receipt.id))
    .get()!;
  expect(f.documents.rekeyScope('session:other-session', 'session:other-canonical')).toBe(0);
  const after = f.db
    .select()
    .from(sessionMessageAcceptanceReceipts)
    .where(eq(sessionMessageAcceptanceReceipts.id, receipt.id))
    .get()!;
  expect(after).toEqual({
    ...before,
    sessionId: 'other-canonical',
    originAuthorityDigest: after.originAuthorityDigest,
  });
  expect(after.originAuthorityDigest).not.toBe(before.originAuthorityDigest);
  expect(f.store.getBatch(batch.batchId)).toMatchObject({
    scope: 'session:session-1',
    admissionReceiptId: receipt.id,
    generation: batch.generation,
  });
  expect(f.store.getGrant(f.grantId)?.targetSessionId).toBe('other-canonical');
  expect(f.queue.list('other-session')).toEqual([]);
  expect(f.queue.list('other-canonical')).toHaveLength(1);
  await expect(f.admission.acceptance.prepare(receipt.id)).resolves.toBeDefined();
});
for (const movement of ['owner', 'target'] as const) {
  it(`a ${movement} canonical move after native FIRST preserves the observed target receipt and quarantines the original batch`, () => {
    const { f, batch, receipt, claim } = fixture();
    claim();
    f.db
      .insert(sessionMetadata)
      .values({
        sessionId: 'other-canonical',
        runtime: 'claude-code',
        agentPath: '/agents/two',
        createdAt: NOW,
      })
      .run();
    const before = f.db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(eq(sessionMessageAcceptanceReceipts.id, receipt.id))
      .get()!;
    f.documents.rekeyScope(
      movement === 'owner' ? 'session:session-1' : 'session:other-session',
      movement === 'owner' ? 'session:canonical' : 'session:other-canonical'
    );
    expect(
      f.db
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, receipt.id))
        .get()
    ).toEqual(before);
    expect(f.store.getBatch(batch.batchId)).toMatchObject({
      generation: batch.generation,
      status: 'in_doubt',
      errorCode: 'identity_changed_after_claim',
    });
    expect(() => f.documents.lifecycle.assertReady(f.documentId)).toThrow();
    expect(f.queue.list('other-session')).toEqual([]);
    expect(() => f.admission.admit(batch.batchId)).toThrow();
  });
}
