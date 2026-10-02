import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  and,
  eq,
  canvasDocBatches,
  canvasDocGrants,
  agents,
  sessionMetadata,
  canvasDocIdentityIntents,
  sessionMessageAcceptanceReceipts,
  sessionMessageQueue,
  connectorAgentRequests,
  createDb,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { CanvasDocumentStore } from '../../canvas-document-store.js';
import { CanvasService, MAX_CANVAS_DOCUMENTS } from '../../canvas-service.js';
import { DocChannelLifecycle } from '../lifecycle.js';
import { DocChannelStore } from '../store.js';
import { FROM, TO, NOW, accept, harness, originDigest, pending } from './lifecycle-fixtures.js';

const connections: Db[] = [];
const directories: string[] = [];
function queueSession(h: ReturnType<typeof harness>, id: string) {
  return h.db.select().from(sessionMessageQueue).where(eq(sessionMessageQueue.id, id)).get()
    ?.sessionId;
}
function setup() {
  const h = harness();
  connections.push(h.db);
  return h;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of connections.splice(0)) db.$client.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const file = { type: 'file', sourcePath: '/src/tasks.md' } as const;

describe('atomic document authority closure', () => {
  it.each(['person', 'agent', 'sweep'] as const)(
    '%s removal closes, revokes and cancels before physical deletion',
    (kind) => {
      const h = setup();
      const doc = h.canvas.open(FROM, 'agent', file);
      const accepted = accept(h);
      pending(h, doc.id, accepted.receipt.id);
      const observer = vi.fn(() => {
        expect(h.documents.lookupIdentity(doc.id)).toBeUndefined();
        expect(h.store.getChannel(doc.id)?.closedAt).toBe(NOW);
      });
      h.canvas.onRemoved(observer);
      if (kind === 'agent')
        h.canvas.apply({
          scope: FROM,
          authorId: 'agent',
          command: { action: 'close_canvas', documentId: doc.id },
        });
      else if (kind === 'sweep') {
        h.canvas.noteSessionOrphaned('session-1');
        h.canvas.sweepOrphanedCanvasDocuments({ sessions: [], degradedRuntimes: [] });
      } else h.canvas.close(FROM, doc.id);
      expect(observer).toHaveBeenCalledOnce();
      expect(h.store.getChannel(doc.id)?.closureEvidence).toMatchObject({ scope: FROM });
      expect(h.store.getGrant(`grant-${doc.id}`)?.revokedAt).toBe(NOW);
      expect(h.store.getBatch(`batch-${doc.id}`)?.status).toBe('cancelled');
      expect(h.queue.get(accepted.receipt.queueMessageId)).toBeUndefined();
      expect(
        h.db
          .select()
          .from(sessionMessageAcceptanceReceipts)
          .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
          .get()?.state
      ).toBe('cancelled');
    }
  );
  it('rolls the closure and authority changes back if physical deletion fails', () => {
    const h = setup();
    const doc = h.canvas.open(FROM, 'agent', file);
    pending(h, doc.id);
    h.db.$client.exec(
      "CREATE TRIGGER refuse_delete BEFORE DELETE ON canvas_documents BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END;"
    );
    expect(() => h.canvas.close(FROM, doc.id)).toThrow('injected delete failure');
    expect(h.documents.lookupIdentity(doc.id)).toBeDefined();
    expect(h.store.getChannel(doc.id)?.closedAt).toBeNull();
    expect(h.store.getGrant(`grant-${doc.id}`)?.revokedAt).toBeNull();
    expect(h.store.getBatch(`batch-${doc.id}`)?.status).toBe('pending');
  });
  it('isolates both publication and listener failures after commit', () => {
    const h = setup();
    const doc = h.canvas.open(FROM, 'agent', file);
    const canvas = new CanvasService({
      documents: h.documents,
      channels: {
        publish: () => {
          throw new Error('publish failed');
        },
        viewers: () => 0,
      },
    });
    const later = vi.fn();
    canvas.onRemoved(() => {
      throw new Error('observer failed');
    });
    canvas.onRemoved(later);
    expect(() => canvas.close(FROM, doc.id)).not.toThrow();
    expect(later).toHaveBeenCalledOnce();
    expect(h.store.getChannel(doc.id)?.closedAt).not.toBeNull();
    expect(() =>
      h.store.appendEvent({
        documentId: doc.id,
        eventId: 'later',
        direction: 'downstream',
        type: 'task.reply',
        payload: {},
        envelopeHash: 'x',
        receivedAt: NOW,
        provenance: {},
      })
    ).toThrow(/closed/);
  });
  it('keeps claimed work and provenance instead of pretending it was cancelled', async () => {
    const h = setup();
    const doc = h.canvas.open(FROM, 'agent', file);
    const accepted = accept(h);
    pending(h, doc.id, accepted.receipt.id);
    h.receipts.claim(accepted.receipt.id, await h.receipts.prepare(accepted.receipt.id));
    h.db
      .update(canvasDocBatches)
      .set({ status: 'dispatching' })
      .where(eq(canvasDocBatches.batchId, `batch-${doc.id}`))
      .run();
    h.canvas.close(FROM, doc.id);
    expect(h.store.getBatch(`batch-${doc.id}`)?.status).toBe('dispatching');
    expect(
      h.db
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
        .get()?.state
    ).toBe('dispatching');
  });
  it('reopens the same source with a distinct incarnation and retains old authority', () => {
    const h = setup();
    const old = h.canvas.open(FROM, 'agent', file);
    pending(h, old.id);
    h.canvas.close(FROM, old.id);
    const reopened = h.canvas.open(FROM, 'agent', file);
    expect(reopened.id).not.toBe(old.id);
    expect(h.canvas.open(FROM, 'agent', file).id).toBe(reopened.id);
    expect(h.store.getChannel(old.id)?.closedAt).toBe(NOW);
    expect(h.store.getGrant(`grant-${old.id}`)?.revokedAt).toBe(NOW);
    expect(h.store.getChannel(reopened.id)).toMatchObject({
      nextDocSeq: 1,
      stateRev: 0,
      closedAt: null,
    });
    expect(h.documents.lookupIdentity(old.id)).toBeUndefined();
  });
  it('eviction retains closure evidence for every physically removed document', () => {
    const h = setup();
    let clock = Date.parse(NOW);
    const canvas = new CanvasService({
      documents: h.documents,
      channels: { publish: () => {}, viewers: () => 0 },
      now: () => clock++,
    });
    const old = canvas.open(FROM, 'agent', file);
    for (let n = 0; n < MAX_CANVAS_DOCUMENTS + 3; n++)
      canvas.open(FROM, 'agent', { type: 'json', data: { n } });
    expect(h.documents.lookupIdentity(old.id)).toBeUndefined();
    expect(h.store.getChannel(old.id)?.closedAt).toBe(NOW);
  });
  it('bulk sweep closes even an unreadable content row', () => {
    const h = setup();
    const doc = h.canvas.open(FROM, 'agent', file);
    h.db.$client
      .prepare('UPDATE canvas_documents SET content = ? WHERE id = ?')
      .run('{"type":"future"}', doc.id);
    h.canvas.noteSessionOrphaned('session-1');
    h.canvas.sweepOrphanedCanvasDocuments({ sessions: [], degradedRuntimes: [] });
    expect(h.store.getChannel(doc.id)?.closedAt).toBe(NOW);
    expect(h.documents.lookupIdentity(doc.id)).toBeUndefined();
  });
});

describe('startup lifecycle initialization', () => {
  it('initializes log-only channels for previously persisted documents without changing document IDs', () => {
    const h = setup();
    const doc = h.canvas.open(FROM, 'agent', file);
    h.db.$client.prepare('DELETE FROM canvas_doc_channels WHERE document_id = ?').run(doc.id);
    const documents = new CanvasDocumentStore(h.db);
    expect(documents.lookupIdentity(doc.id)?.id).toBe(doc.id);
    expect(h.store.getChannel(doc.id)).toMatchObject({
      documentId: doc.id,
      scope: FROM,
      nextDocSeq: 1,
      stateRev: 0,
      closedAt: null,
    });
  });
});

describe('canonical document ownership transactions', () => {
  it('moves a targeted grant only while its frozen approved path remains unchanged', () => {
    const h = setup();
    const doc = h.canvas.open(FROM, 'agent', file);
    pending(h, doc.id);
    const approvalEvidence = { binding: { target: { agentPath: '/agents/one' } } };
    h.db
      .update(canvasDocGrants)
      .set({
        targetAgentId: 'agent-1',
        targetSessionId: 'session-1',
        targetRuntime: 'claude-code',
        approvalEvidence,
      })
      .where(eq(canvasDocGrants.grantId, `grant-${doc.id}`))
      .run();
    h.documents.rekeyScope(FROM, TO);
    expect(h.store.getGrant(`grant-${doc.id}`)).toMatchObject({
      targetSessionId: 'canonical',
      approvalEvidence,
    });
  });
  it('blocks relocated source and target records that no longer match the frozen grant path', () => {
    const h = setup();
    const doc = h.canvas.open(FROM, 'agent', file);
    pending(h, doc.id);
    h.db
      .update(canvasDocGrants)
      .set({
        targetAgentId: 'agent-1',
        targetSessionId: 'session-1',
        targetRuntime: 'claude-code',
        approvalEvidence: { binding: { target: { agentPath: '/agents/one' } } },
      })
      .where(eq(canvasDocGrants.grantId, `grant-${doc.id}`))
      .run();
    h.db.update(agents).set({ projectPath: '/agents/two' }).where(eq(agents.id, 'agent-1')).run();
    h.db.update(sessionMetadata).set({ agentPath: '/agents/two' }).run();
    expect(() => h.documents.rekeyScope(FROM, TO)).toThrow();
    expect(h.store.getGrant(`grant-${doc.id}`)?.targetSessionId).toBe('session-1');
    expect(h.documents.lookupIdentity(doc.id)?.scope).toBe(FROM);
  });

  it('blocks targeted grant movement when the canonical agent path differs from the source', () => {
    const h = setup();
    const doc = h.canvas.open(FROM, 'agent', file);
    pending(h, doc.id);
    h.db
      .update(canvasDocGrants)
      .set({
        targetAgentId: 'agent-1',
        targetSessionId: 'session-1',
        targetRuntime: 'claude-code',
      })
      .where(eq(canvasDocGrants.grantId, `grant-${doc.id}`))
      .run();
    h.db.update(agents).set({ projectPath: '/agents/two' }).where(eq(agents.id, 'agent-1')).run();
    h.db
      .update(sessionMetadata)
      .set({ agentPath: '/agents/two' })
      .where(eq(sessionMetadata.sessionId, 'canonical'))
      .run();
    expect(() => h.documents.rekeyScope(FROM, TO)).toThrow();
    expect(h.documents.lookupIdentity(doc.id)?.scope).toBe(FROM);
    expect(h.store.getGrant(`grant-${doc.id}`)?.targetSessionId).toBe('session-1');
    expect(h.store.getBatch(`batch-${doc.id}`)?.scope).toBe(FROM);
    expect(h.documents.lifecycle.health(doc.id).status).toBe('in_doubt');
  });

  it('moves exact accepted identity, validated digest and safe queue with the document', async () => {
    const h = setup();
    const doc = h.canvas.open(FROM, 'agent', file);
    const accepted = accept(h);
    pending(h, doc.id, accepted.receipt.id);
    const prepared = await h.receipts.prepare(accepted.receipt.id);
    h.documents.rekeyScope(FROM, TO);
    const receipt = h.db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
      .get()!;
    expect(receipt).toEqual({
      ...accepted.receipt,
      sessionId: 'canonical',
      originAuthorityDigest: originDigest('canonical'),
    });
    expect(h.queue.get(receipt.queueMessageId)).toMatchObject({
      id: accepted.receipt.queueMessageId,
      content: '[Private connection update]',
    });
    expect(queueSession(h, receipt.queueMessageId)).toBe('canonical');
    expect(h.documents.lookupIdentity(doc.id)?.scope).toBe(TO);
    expect(h.store.getChannel(doc.id)).toMatchObject({ scope: TO, nextDocSeq: 2, stateRev: 0 });
    expect(h.store.getBatch(`batch-${doc.id}`)).toMatchObject({
      scope: TO,
      generation: 'batch-generation',
      admissionReceiptId: accepted.receipt.id,
    });
    expect(h.documents.lifecycle.resolveScope(FROM)).toBe(TO);
    expect(h.receipts.claim(receipt.id, prepared)).toMatchObject({
      receiptId: accepted.receipt.id,
    });
    expect(() => h.receipts.claim(receipt.id, prepared)).toThrow();
  });
  it('preserves both documents and all receipt/queue fields on a source collision', async () => {
    const h = setup();
    const doc = h.canvas.open(FROM, 'agent', file);
    const target = h.canvas.open(TO, 'agent', file);
    const accepted = accept(h);
    pending(h, doc.id, accepted.receipt.id);
    expect(() => h.documents.rekeyScope(FROM, TO)).toThrow(/collision/);
    expect(h.documents.lookupIdentity(doc.id)?.scope).toBe(FROM);
    expect(h.documents.lookupIdentity(target.id)?.scope).toBe(TO);
    expect(
      h.db
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
        .get()
    ).toEqual(accepted.receipt);
    expect(queueSession(h, accepted.receipt.queueMessageId)).toBe('session-1');
    expect(() => h.documents.lifecycle.assertReady(doc.id)).toThrow(/recovery/);
    const prepared = await h.receipts.prepare(accepted.receipt.id);
    expect(() => h.receipts.claim(accepted.receipt.id, prepared)).toThrow(/not available/);
    expect(h.documents.lifecycle.health(doc.id)).toEqual({
      status: 'in_doubt',
      reasons: ['identity_move_failed'],
    });
    h.queue.rekeySession('session-1', 'canonical');
    expect(queueSession(h, accepted.receipt.queueMessageId)).toBe('session-1');
  });
  it('rolls source callback, receipts and queue back when a final document update fails', () => {
    const h = setup();
    const doc = h.canvas.open(FROM, 'agent', file);
    const accepted = accept(h);
    pending(h, doc.id, accepted.receipt.id);
    h.db.$client.exec(
      "CREATE TRIGGER refuse_move BEFORE UPDATE OF scope ON canvas_documents BEGIN SELECT RAISE(ABORT, 'injected move failure'); END;"
    );
    expect(() => h.documents.rekeyScope(FROM, TO)).toThrow('injected move failure');
    expect(
      h.db
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
        .get()
    ).toEqual(accepted.receipt);
    expect(
      h.db
        .select()
        .from(connectorAgentRequests)
        .where(eq(connectorAgentRequests.id, 'request'))
        .get()?.originAuthorityDigest
    ).toBe(originDigest('session-1'));
    expect(queueSession(h, accepted.receipt.queueMessageId)).toBe('session-1');
    expect(h.store.getChannel(doc.id)?.scope).toBe(FROM);
  });
  it('refuses accepted receipt movement when its source has no rebind validator', () => {
    const h = setup();
    const doc = h.canvas.open(FROM, 'agent', file);
    const accepted = accept(h);
    pending(h, doc.id, accepted.receipt.id);
    expect(() => new DocChannelLifecycle(h.db).rekeyScope(FROM, TO)).toThrow(/recovery/);
    expect(queueSession(h, accepted.receipt.queueMessageId)).toBe('session-1');
    expect(h.documents.lookupIdentity(doc.id)?.scope).toBe(FROM);
  });
  it('quarantines claimed work while preserving its observed receipt and source generation', async () => {
    const h = setup();
    const doc = h.canvas.open(FROM, 'agent', file);
    const accepted = accept(h);
    pending(h, doc.id, accepted.receipt.id);
    h.receipts.claim(accepted.receipt.id, await h.receipts.prepare(accepted.receipt.id));
    const before = h.db
      .select()
      .from(sessionMessageAcceptanceReceipts)
      .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
      .get();
    h.documents.rekeyScope(FROM, TO);
    expect(
      h.db
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
        .get()
    ).toEqual(before);
    expect(h.store.getBatch(`batch-${doc.id}`)).toMatchObject({
      status: 'in_doubt',
      generation: 'batch-generation',
    });
    expect(() => h.documents.lifecycle.assertReady(doc.id)).toThrow(/recovery/);
    expect(h.db.select().from(sessionMessageAcceptanceReceipts).all()).toHaveLength(1);
  });
  it('does not move unrelated protected-source receipts', () => {
    const h = setup();
    const doc = h.canvas.open(FROM, 'agent', file);
    const accepted = accept(h);
    h.documents.rekeyScope(FROM, TO);
    expect(
      h.db
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
        .get()
    ).toEqual(accepted.receipt);
    expect(h.documents.lookupIdentity(doc.id)?.scope).toBe(TO);
  });
  it('repairs a failed durable move on restart before exposing its alias', () => {
    const directory = mkdtempSync(join(tmpdir(), 'doc-lifecycle-'));
    directories.push(directory);
    const path = join(directory, 'db.sqlite');
    const h = harness(path);
    const doc = h.canvas.open(FROM, 'agent', file);
    h.db.$client.exec(
      "CREATE TRIGGER refuse_move BEFORE UPDATE OF scope ON canvas_documents BEGIN SELECT RAISE(ABORT, 'failure'); END;"
    );
    expect(() => h.documents.rekeyScope(FROM, TO)).toThrow();
    h.db.$client.exec('DROP TRIGGER refuse_move');
    h.db.$client.close();
    const db = createDb(path);
    connections.push(db);
    runMigrations(db);
    const documents = new CanvasDocumentStore(db);
    expect(documents.lookupIdentity(doc.id)?.scope).toBe(TO);
    expect(documents.lifecycle.resolveScope(FROM)).toBe(TO);
    expect(new DocChannelStore(db).getChannel(doc.id)?.scope).toBe(TO);
    expect(
      db
        .select()
        .from(canvasDocIdentityIntents)
        .where(
          and(
            eq(canvasDocIdentityIntents.documentId, doc.id),
            eq(canvasDocIdentityIntents.status, 'applied')
          )
        )
        .get()
    ).toBeDefined();
  });
});
