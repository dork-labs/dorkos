const account = vi.hoisted(() => ({ owner: undefined as { id: string } | undefined }));
vi.mock('../../../core/auth/index.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readOwnerAccount: () => account.owner,
}));
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  agents,
  sessionMetadata,
  createDb,
  runMigrations,
  sessionMessageAcceptanceReceipts,
  sessionMessageQueue,
  type Db,
} from '@dorkos/db';
import { createRoomSubsystem, type RoomSubsystem } from '../../../rooms/index.js';
import { RoomRepoStore } from '../../../rooms/repo/room-repo-store.js';
import { ApprovalService } from '../../../core/approvals/approval-service.js';
import { randomUUID } from 'node:crypto';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { createDocChannelHttpComposition } from '../http-composition.js';
import { privateDocTurnBudget } from '../delivery/final-budget.js';

let db: Db;
let rooms: RoomSubsystem;
let approvals: ApprovalService;
let http: ReturnType<typeof createDocChannelHttpComposition>;
let documentId: string;
const actor = () => ({
  surface: 'http' as const,
  principal: createServerPrincipal({
    kind: 'operator',
    owner: account.owner
      ? { kind: 'user', userId: account.owner.id }
      : { kind: 'local_install', installationId: 'test-install' },
  }),
});
beforeEach(() => {
  account.owner = undefined;
  db = createDb(':memory:');
  runMigrations(db);
  rooms = createRoomSubsystem({ db });
  approvals = new ApprovalService(db);
  http = createDocChannelHttpComposition({
    db,
    documents: rooms.canvasDocuments,
    rooms: rooms.service,
    roomStore: rooms.store,
    roomRepos: new RoomRepoStore(db, '/unused'),
    approvals,
    installationId: 'test-install',
  });
  const now = new Date().toISOString();
  for (const id of ['a', 'b']) {
    db.insert(agents)
      .values({
        id,
        name: id,
        projectPath: `/agents/${id}`,
        runtime: 'codex',
        registeredAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(sessionMetadata)
      .values({
        sessionId: `session-${id}`,
        agentPath: `/agents/${id}`,
        runtime: 'codex',
        createdAt: now,
      })
      .run();
  }
  documentId = rooms.canvas.open('session:session-a', 'owner', {
    type: 'url',
    url: 'https://example.test/app',
  }).id;
  http.grants.configure(
    documentId,
    {
      routes: [
        { id: 'other', on: 'task.*', to: 'agent:a', turn: { mode: 'immediate', maxBatch: 100 } },
      ],
    },
    actor(),
    'a'
  );
});
afterEach(() => {
  db.$client.close();
});
const input = () => ({
  documentId,
  routeId: 'other',
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
});

it('refuses background grant authority after installation owner changes', async () => {
  const request = input();
  const originalActor = actor();
  const pending = http.grants.grant(request, originalActor);
  if (pending.kind !== 'approval_required') throw new Error('expected approval');
  approvals.grant(pending.ticket.approvalId);
  const approved = http.grants.grant(request, originalActor, pending.ticket.token);
  if (approved.kind !== 'granted') throw new Error('expected approved grant');
  const event = await http.service.ingestEvent(
    documentId,
    { v: 1, id: randomUUID(), type: 'task.comment', payload: { text: 'private' } },
    originalActor
  );
  const batch = http.channels.getBatch(event.deliveries[0]!.batchId!)!;
  account.owner = { id: 'new-owner' };
  await expect(http.service.replay(documentId, originalActor)).rejects.toThrow();
  expect(() =>
    http.channels.transaction((tx) => http.grants.revalidateBatchGrant(batch, tx))
  ).toThrow();
});

it('does not admit a pending owner-scoped input after owner proof changes', async () => {
  const request = input();
  const originalActor = actor();
  const pending = http.grants.grant(request, originalActor);
  if (pending.kind !== 'approval_required') throw new Error('approval');
  approvals.grant(pending.ticket.approvalId);
  const granted = http.grants.grant(request, originalActor, pending.ticket.token);
  if (granted.kind !== 'granted') throw new Error('grant');
  const event = await http.service.ingestEvent(
    documentId,
    { v: 1, id: randomUUID(), type: 'task.comment', payload: { text: 'private' } },
    originalActor
  );
  const batchId = event.deliveries[0]!.batchId!;
  const { DocBatchAdmission } = await import('../delivery/batch-admission.js');
  const { MessageQueueStore } = await import('../../../session/message-queue-store.js');
  const admission = new DocBatchAdmission({
    db,
    store: http.channels,
    grants: http.grants,
    lifecycle: rooms.canvasDocuments.lifecycle,
    queue: new MessageQueueStore(db),
    bootEpoch: 'test',
    beforeClaim: privateDocTurnBudget,
  });
  admission.initializeBoot();
  const receiptBefore = db.select().from(sessionMessageAcceptanceReceipts).all();
  const queueBefore = db.select().from(sessionMessageQueue).all();
  const batchBefore = http.channels.getBatch(batchId);
  account.owner = { id: 'new-owner' };
  expect(() => admission.admit(batchId)).toThrow();
  expect(db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual(receiptBefore);
  expect(db.select().from(sessionMessageQueue).all()).toEqual(queueBefore);
  expect(http.channels.getBatch(batchId)).toEqual(batchBefore);
});

it.each([undefined, 'same-user'] as const)(
  'admits an actual approved route when the recorded %s owner still matches',
  async (userId) => {
    account.owner = userId ? { id: userId } : undefined;
    const request = input();
    const originalActor = actor();
    const pending = http.grants.grant(request, originalActor);
    if (pending.kind !== 'approval_required') throw new Error('approval');
    approvals.grant(pending.ticket.approvalId);
    const granted = http.grants.grant(request, originalActor, pending.ticket.token);
    if (granted.kind !== 'granted') throw new Error('grant');
    const event = await http.service.ingestEvent(
      documentId,
      { v: 1, id: randomUUID(), type: 'task.comment', payload: { text: 'private' } },
      originalActor
    );
    const batchId = event.deliveries[0]!.batchId!;
    const { DocBatchAdmission } = await import('../delivery/batch-admission.js');
    const { MessageQueueStore } = await import('../../../session/message-queue-store.js');
    const admission = new DocBatchAdmission({
      db,
      store: http.channels,
      grants: http.grants,
      lifecycle: rooms.canvasDocuments.lifecycle,
      queue: new MessageQueueStore(db),
      bootEpoch: 'test',
      beforeClaim: privateDocTurnBudget,
    });
    admission.initializeBoot();
    const accepted = admission.admit(batchId);
    expect(accepted.receipt).toMatchObject({
      sourceId: batchId,
      sourceKind: 'document_event_batch',
      state: 'accepted',
    });
    expect(db.select().from(sessionMessageQueue).all()).toHaveLength(1);
  }
);

it.each([undefined, 'old-user'] as const)(
  'keeps the recorded %s owner grant unavailable to a new current operator',
  async (userId) => {
    account.owner = userId ? { id: userId } : undefined;
    const request = input();
    const originalActor = actor();
    const pending = http.grants.grant(request, originalActor);
    if (pending.kind !== 'approval_required') throw new Error('approval');
    approvals.grant(pending.ticket.approvalId);
    const granted = http.grants.grant(request, originalActor, pending.ticket.token);
    if (granted.kind !== 'granted') throw new Error('grant');
    account.owner = { id: 'new-owner' };
    const currentActor = actor();
    await expect(http.service.replay(documentId, currentActor)).resolves.toBeDefined();
    expect(() =>
      http.grants.revalidateGrant(documentId, granted.grant.grantId, currentActor)
    ).toThrow();
    expect(http.grants.getCurrentRoutes(documentId, 'task.comment', currentActor)).toEqual([
      expect.objectContaining({ reason: 'GRANT_AUTHORITY_LOST' }),
    ]);
    const event = await http.service.ingestEvent(
      documentId,
      { v: 1, id: randomUUID(), type: 'task.comment', payload: { text: 'saved only' } },
      currentActor
    );
    expect(event.deliveries).toEqual([
      expect.objectContaining({ status: 'saved', reason: 'GRANT_AUTHORITY_LOST', batchId: null }),
    ]);
    expect(db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([]);
    expect(db.select().from(sessionMessageQueue).all()).toEqual([]);
    const savedDeliveries = http.channels.listDeliveries(documentId, event.receipt.id);
    const freshApproval = http.grants.grant(request, currentActor);
    if (freshApproval.kind !== 'approval_required') throw new Error('fresh approval required');
    approvals.grant(freshApproval.ticket.approvalId);
    const freshGrant = http.grants.grant(request, currentActor, freshApproval.ticket.token);
    if (freshGrant.kind !== 'granted') throw new Error('fresh grant');
    expect(freshGrant.grant.grantId).not.toBe(granted.grant.grantId);
    expect(http.grants.getCurrentRoutes(documentId, 'task.comment', currentActor)[0]).toMatchObject(
      {
        grantId: freshGrant.grant.grantId,
      }
    );
    // New approval enables future input, without replaying the saved old-owner input.
    expect(http.channels.listDeliveries(documentId, event.receipt.id)).toEqual(savedDeliveries);
    expect(db.select().from(sessionMessageAcceptanceReceipts).all()).toEqual([]);
    expect(db.select().from(sessionMessageQueue).all()).toEqual([]);
    const future = await http.service.ingestEvent(
      documentId,
      { v: 1, id: randomUUID(), type: 'task.comment', payload: { text: 'new owner input' } },
      currentActor
    );
    expect(future.deliveries).toHaveLength(1);
    const batch = http.channels.getBatch(future.deliveries[0]!.batchId!)!;
    expect(batch).toMatchObject({ grantId: freshGrant.grant.grantId, status: 'pending' });
    expect(batch.inputEventIds).toEqual([future.receipt.id]);
    expect(http.channels.listDeliveries(documentId, event.receipt.id)).toEqual(savedDeliveries);
  }
);
