/** Shared real-SQLite fixtures for downstream and exact responder proofs. */
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterEach, vi } from 'vitest';
import {
  canvasDocChannels,
  canvasDocuments,
  agents,
  sessionMetadata,
  eq,
  type Db,
} from '@dorkos/db';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { ApprovalService } from '../../../core/approvals/approval-service.js';
import { DocChannelAuthorization, type DocChannelActor } from '../authorization.js';
import { DocChannelDownstream } from '../downstream/service.js';
import { createDocDownstreamAuthority } from '../downstream/authority.js';
import { DocChannelGrants } from '../grants.js';
import { harness, NOW, FROM } from './lifecycle-fixtures.js';
/** Test resources closed after each proof. */
export const databases: Db[] = [];
/** Test resources closed after each proof. */
export const folders: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.$client.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const owner = { kind: 'local_install', installationId: 'installation' } as const;
/** Build a verified temporary document-channel test fixture or request. */
export function actor(
  agentId = 'agent-1',
  sessionId = 'session-1',
  agentPath = '/agents/one'
): DocChannelActor {
  return {
    surface: 'capability',
    principal: createServerPrincipal({
      kind: 'runtime',
      owner,
      bindingId: `binding-${agentId}`,
      runtime: 'claude-code',
      canonicalSessionId: sessionId,
      agentId,
      agentPath,
    }),
  };
}
/** Build a verified temporary document-channel test fixture or request. */
export function fixture(senderLimit = 60, filename = ':memory:') {
  const h = harness(filename);
  databases.push(h.db);
  const doc = h.canvas.open(FROM, 'agent', { type: 'markdown', content: 'editable original' });
  h.db
    .update(canvasDocChannels)
    .set({ openerAgentId: 'agent-1' })
    .where(eq(canvasDocChannels.documentId, doc.id))
    .run();
  let current = true;
  const authorization = new DocChannelAuthorization(h.db, h.documents, {
    ownsInstallation: (claims) =>
      claims.owner.kind === 'local_install' && claims.owner.installationId === 'installation',
    roomMembership: () => undefined,
    principalCurrent: () => current,
  });
  const approval = new ApprovalService(h.db);
  const grants = new DocChannelGrants({
    db: h.db,
    store: h.store,
    approvals: approval,
    now: () => new Date(NOW),
    authority: {
      resolveScope: (scope) => h.documents.lifecycle.resolveScope(scope),
      requireCurrent: (id, caller, write, tx) =>
        authorization.requireCurrent(id, caller, write, tx),
      requireGrantedCurrent: (grant, tx) => {
        const physical = tx
          .select()
          .from(canvasDocuments)
          .where(eq(canvasDocuments.id, grant.documentId))
          .get();
        const channel = h.store.getChannel(grant.documentId, tx);
        h.documents.lifecycle.assertReady(grant.documentId);
        if (
          !physical ||
          !channel ||
          channel.closedAt ||
          !current ||
          physical.scope !== channel.scope
        )
          throw new Error('ACCESS_LOST');
        return { id: physical.id, scope: physical.scope };
      },
      sourceRoot: () => null,
      originCurrent: () => true,
      resolveTarget: ({ scope, route }, tx) => {
        const id = route.to === 'agent:owner' ? 'agent-1' : 'target';
        const row = (tx ?? h.db).select().from(agents).where(eq(agents.id, id)).get()!;
        return {
          agentId: id,
          sessionId: id === 'agent-1' ? 'session-1' : 'target-session',
          runtime: row.runtime,
          agentPath: row.projectPath,
          scope,
        };
      },
    },
  });
  const authority = createDocDownstreamAuthority(h.store, authorization, grants, {
    principalCurrent: () => current,
    revalidateRuntime: async () => current,
    ownsInstallation: (claims) =>
      claims.owner.kind === 'local_install' && claims.owner.installationId === 'installation',
    resolveScope: (scope) => h.documents.lifecycle.resolveScope(scope),
  });
  return {
    ...h,
    doc,
    authorization,
    grants,
    approval,
    authority,
    service: new DocChannelDownstream(h.store, authority, () => new Date(NOW), senderLimit),
    revokePrincipal: () => {
      current = false;
    },
  };
}
/** Build a verified temporary document-channel test fixture or request. */
export function send(documentId: string, payload: unknown = { text: 'hello' }) {
  return { documentId, eventId: randomUUID(), type: 'app.reply', payload };
}
/** Build a verified temporary document-channel test fixture or request. */
export function patch(
  documentId: string,
  expectedStateRev = 0,
  operations: unknown[] = [{ op: 'set', path: '/count', value: 1 }]
) {
  return { documentId, eventId: randomUUID(), expectedStateRev, operations };
}
/** Build a verified temporary document-channel test fixture or request. */
export function ackFixture() {
  const f = fixture();
  f.db
    .insert(agents)
    .values({
      id: 'target',
      name: 'target',
      runtime: 'claude-code',
      projectPath: '/agents/target',
      registeredAt: NOW,
      updatedAt: NOW,
    })
    .run();
  f.db
    .insert(sessionMetadata)
    .values({
      sessionId: 'target-session',
      runtime: 'claude-code',
      agentPath: '/agents/target',
      createdAt: NOW,
    })
    .run();
  const route = {
    id: 'route',
    on: 'task.*',
    to: 'agent:target' as const,
    turn: { mode: 'immediate' as const, maxBatch: 100 },
  };
  f.grants.configure(f.doc.id, { routes: [route] }, actor());
  const request = { documentId: f.doc.id, routeId: 'route', expiresAt: '2026-10-01T13:00:00.000Z' };
  const pending = f.grants.grant(request, actor());
  if (pending.kind !== 'approval_required') throw new Error('Expected exact operator approval');
  f.approval.grant(pending.ticket.approvalId);
  const granted = f.grants.grant(request, actor(), pending.ticket.token);
  if (granted.kind !== 'granted') throw new Error('Expected granted route');
  const ids = [randomUUID(), randomUUID()];
  for (const eventId of ids)
    f.store.appendEvent({
      documentId: f.doc.id,
      eventId,
      direction: 'upstream',
      type: 'task.comment',
      payload: { text: eventId },
      envelopeHash: 'hash',
      envelopeBytes: 100,
      provenance: {},
      receivedAt: NOW,
    });
  f.store.insertBatch({
    batchId: 'batch',
    documentId: f.doc.id,
    scope: FROM,
    routeId: 'route',
    grantId: granted.grant.grantId,
    grantRevision: granted.grant.revision,
    generation: 'generation',
    inputEventIds: ids,
    effectivePayload: { eventIds: ids },
    dueAt: NOW,
    status: 'turn_done',
    turnId: 'turn',
    createdAt: NOW,
    updatedAt: NOW,
  });
  for (const eventId of ids)
    f.store.insertDelivery({
      documentId: f.doc.id,
      eventId,
      routeId: 'route',
      batchId: 'batch',
      status: 'turn_done',
      turnId: 'turn',
      updatedAt: NOW,
    });
  const responder = actor('target', 'target-session', '/agents/target');
  const ack = (eventIds = [ids[0]!], outcome = 'handled') => ({
    ...send(f.doc.id),
    type: 'app.ack',
    payload: { batchId: 'batch', routeId: 'route', eventIds, outcome },
  });
  return { ...f, ids, responder, ack, grant: granted.grant };
}
