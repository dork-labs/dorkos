/** Real migrated grants, ownership and acceptance used by document dispatch proofs. */
import { randomUUID } from 'node:crypto';
import {
  agents,
  canvasDocChannels,
  canvasDocuments,
  createDb,
  eq,
  runMigrations,
  sessionMetadata,
  type Db,
} from '@dorkos/db';
import { ApprovalService } from '../../../core/approvals/approval-service.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { CanvasDocumentStore } from '../../canvas-document-store.js';
import { CanvasService } from '../../canvas-service.js';
import { MessageQueueStore } from '../../../session/message-queue-store.js';
import { DocChannelStore } from '../store.js';
import { DocChannelGrants } from '../grants.js';
import { DocRouteGrantError, type DocGrantAuthority } from '../grant-policy.js';
import { DocBatchAdmission } from '../delivery/batch-admission.js';
import type { DocIngestResult } from '../ingest.js';
import type { DocGrantActor } from '../grant-policy.js';
import { DocChannelIngest } from '../ingest.js';
import { seedAuthority, NOW, FROM, TO } from './lifecycle-fixtures.js';
export { NOW, FROM, TO };
export interface BatchFixture {
  db: Db;
  documents: CanvasDocumentStore;
  store: DocChannelStore;
  canvas: CanvasService;
  actor: DocGrantActor;
  grants: DocChannelGrants;
  grantId: string;
  documentId: string;
  queue: MessageQueueStore;
  admission: DocBatchAdmission;
  authority: DocGrantAuthority;
  input(payload?: Record<string, string | boolean>): DocIngestResult;
  batchId(): string;
}
export function batchFixture(
  file = ':memory:',
  sourceRoot: string | null = null,
  existing?: { db: Db; documentId: string; grantId: string },
  bootEpoch = 'boot-1',
  runtime: 'claude-code' | 'codex' | 'opencode' | 'test-mode' = 'claude-code'
): BatchFixture {
  const db = existing?.db ?? createDb(file);
  if (!existing) {
    runMigrations(db);
    seedAuthority(db);
    db.update(agents).set({ runtime }).run();
    db.update(sessionMetadata).set({ runtime }).run();
  }
  const documents = new CanvasDocumentStore(db, { now: () => NOW });
  const store = new DocChannelStore(db);
  const canvas = new CanvasService({
    documents,
    channels: { publish: () => {}, viewers: () => 0 },
    now: () => Date.parse(NOW),
  });
  const documentId =
    existing?.documentId ??
    canvas.open(FROM, 'agent-1', {
      type: 'markdown',
      title: 'Private tasks',
      content: 'Private body',
    }).id;
  if (!existing)
    db.update(canvasDocChannels)
      .set({ openerAgentId: 'agent-1' })
      .where(eq(canvasDocChannels.documentId, documentId))
      .run();
  const actor = {
    surface: 'capability' as const,
    principal: createServerPrincipal(
      runtime === 'test-mode'
        ? {
            kind: 'agent',
            owner: { kind: 'local_install', installationId: 'installation' },
            agentId: 'agent-1',
            agentPath: '/agents/one',
          }
        : {
            kind: 'runtime',
            owner: { kind: 'local_install', installationId: 'installation' },
            bindingId: 'binding',
            runtime,
            canonicalSessionId: 'session-1',
            agentId: 'agent-1',
            agentPath: '/agents/one',
          }
    ),
  };
  const live = (id: string) => {
    documents.lifecycle.assertReady(id);
    const physical = db.select().from(canvasDocuments).where(eq(canvasDocuments.id, id)).get();
    const channel = store.getChannel(id);
    if (!physical || channel?.closedAt !== null || physical.scope !== channel.scope)
      throw new DocRouteGrantError('ACCESS_LOST');
    const agent = db.select().from(agents).where(eq(agents.id, 'agent-1')).get();
    const session = db
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, physical.scope.slice(8)))
      .get();
    if (
      !agent ||
      agent.status !== 'active' ||
      !session ||
      agent.runtime !== session.runtime ||
      agent.projectPath !== session.agentPath
    )
      throw new DocRouteGrantError('ACCESS_LOST');
    return { id, scope: physical.scope };
  };
  const authority: DocGrantAuthority = {
    resolveScope: (scope) => documents.lifecycle.resolveScope(scope),
    requireCurrent: live,
    requireGrantedCurrent: (grant) => {
      const origin = (
        grant.approvalEvidence as {
          binding: { origin: { owner: { kind: string; installationId: string } } };
        }
      ).binding.origin;
      if (origin.owner.kind !== 'local_install' || origin.owner.installationId !== 'installation')
        throw new DocRouteGrantError('ACCESS_LOST');
      return live(grant.documentId);
    },
    resolveTarget: ({ scope }) => {
      const session = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, scope.slice(8)))
        .get()!;
      const agent = db.select().from(agents).where(eq(agents.id, 'agent-1')).get()!;
      return {
        agentId: agent.id,
        sessionId: session.sessionId,
        runtime: session.runtime,
        agentPath: session.agentPath,
        scope,
      };
    },
    sourceRoot: () => sourceRoot,
    originCurrent: () =>
      db.select().from(agents).where(eq(agents.id, 'agent-1')).get()?.status === 'active',
  };
  const grants = new DocChannelGrants({
    db,
    store,
    authority,
    approvals: new ApprovalService(db),
    now: () => new Date(NOW),
  });
  if (!existing)
    grants.configure(
      documentId,
      {
        routes: [
          {
            id: 'route',
            on: 'task.*',
            to: 'agent:owner',
            turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 100 },
          },
        ],
      },
      actor
    );
  const result = existing
    ? null
    : grants.grant({ documentId, routeId: 'route', expiresAt: '2026-10-02T00:00:00.000Z' }, actor);
  if (result && result.kind !== 'granted') throw new Error('Expected self grant');
  const grantId = existing?.grantId ?? (result!.kind === 'granted' ? result!.grant.grantId : '');
  const queue = new MessageQueueStore(db);
  const admission = new DocBatchAdmission({
    db,
    store,
    grants,
    lifecycle: documents.lifecycle,
    queue,
    bootEpoch,
    now: () => new Date(NOW),
  });
  admission.initializeBoot();
  const ingest = new DocChannelIngest(store, () => new Date(NOW));
  function input(payload: Record<string, string | boolean> = { checked: true }) {
    grants.refreshGrantedAuthority(grantId);
    return ingest.accept({ v: 1, id: randomUUID(), type: 'task.toggle', payload }, (tx) => {
      const access = live(documentId);
      const routes = grants.getCurrentRoutes(documentId, 'task.toggle', actor, tx);
      return {
        documentId,
        scope: access.scope,
        documentLabel: 'Private tasks',
        provenance: { trust: 'app_untrusted' },
        routes,
      };
    });
  }
  function batchId() {
    return db.$client
      .prepare(
        "SELECT batch_id FROM canvas_doc_batches WHERE document_id=? AND status IN ('pending','waiting')"
      )
      .get(documentId) as { batch_id: string };
  }
  return {
    db,
    documents,
    store,
    canvas,
    actor,
    grants,
    grantId,
    documentId,
    queue,
    admission,
    authority,
    input,
    batchId: () => batchId().batch_id,
  };
}
