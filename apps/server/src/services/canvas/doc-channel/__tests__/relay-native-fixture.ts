import {
  openServerDatabase,
  consumeServerNativeRelayConstruction,
  type FixedNativeRelayFacts,
  type ServerNativeRelayConstruction,
} from '@dorkos/db/internal-server';
import { createDocBeforeClaim } from '../delivery/private-gates.js';
import { documentRouteTurnBudget } from '../delivery/final-budget.js';
/** Real migrated grants, ownership and acceptance used by document dispatch proofs. */
import { randomUUID } from 'node:crypto';
import {
  agents,
  canvasDocChannels,
  canvasDocuments,
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
  readonly native: FixedNativeRelayFacts;
  readonly serverNativeRelayConstruction: ServerNativeRelayConstruction;
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
export function nativeRelayFixture(
  file = ':memory:',
  sourceRoot: string | null = null,
  bootEpoch = 'boot-1',
  runtime: 'claude-code' | 'codex' | 'opencode' | 'test-mode' = 'claude-code',
  options: {
    now?: string;
    agentPath?: string;
    targetAgentPath?: string;
    clock?: () => Date;
    destination?: 'log';
    nativeLedgerOnly?: boolean;
  } = {}
): BatchFixture {
  const opened = openServerDatabase(file),
    db = opened.db;
  let native: FixedNativeRelayFacts | undefined;
  const clock = options.clock ?? (() => new Date(options.now ?? NOW));
  const now = clock().toISOString(),
    agentPath = options.agentPath ?? '/agents/one';
  try {
    {
      runMigrations(db);
      seedAuthority(db);
      db.update(agents).set({ runtime, projectPath: agentPath }).run();
      db.update(sessionMetadata).set({ runtime, agentPath }).run();
      if (options.targetAgentPath) {
        db.$client
          .prepare(
            'INSERT INTO agents (id,name,runtime,project_path,registered_at,updated_at) VALUES (?,?,?,?,?,?)'
          )
          .run('agent-2', 'two', runtime, options.targetAgentPath, now, now);
        db.insert(sessionMetadata)
          .values({
            sessionId: 'other-session',
            runtime,
            agentPath: options.targetAgentPath,
            createdAt: now,
          })
          .run();
      }
    }
    const documents = new CanvasDocumentStore(db, { now: () => clock().toISOString() });
    const store = new DocChannelStore(db);
    const canvas = new CanvasService({
      documents,
      channels: { publish: () => {}, viewers: () => 0 },
      now: () => clock().getTime(),
    });
    const documentId = canvas.open(FROM, 'agent-1', {
      type: 'markdown',
      title: 'Private tasks',
      content: 'Private body',
    }).id;

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
              agentPath,
            }
          : {
              kind: 'runtime',
              owner: { kind: 'local_install', installationId: 'installation' },
              bindingId: 'binding',
              runtime,
              canonicalSessionId: 'session-1',
              agentId: 'agent-1',
              agentPath,
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
      resolveTarget: ({ scope, route }) => {
        if (route.to === 'log')
          return { scope, agentId: null, sessionId: null, runtime: null, agentPath: null };
        if (route.to === 'agent:agent-2') {
          const target = db.select().from(agents).where(eq(agents.id, 'agent-2')).get();
          const session = db
            .select()
            .from(sessionMetadata)
            .where(
              eq(
                sessionMetadata.sessionId,
                documents.lifecycle.resolveScope('session:other-session').slice(8)
              )
            )
            .get();
          if (
            !target ||
            target.status !== 'active' ||
            !session ||
            session.runtime !== target.runtime ||
            session.agentPath !== target.projectPath
          )
            throw new DocRouteGrantError('TARGET_IDENTITY_CHANGED');
          return {
            agentId: target.id,
            sessionId: session.sessionId,
            runtime: session.runtime,
            agentPath: session.agentPath,
            scope,
          };
        }
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
      now: clock,
    });

    grants.configure(
      documentId,
      {
        routes: [
          {
            id: 'route',
            on: 'task.*',
            to:
              options.destination === 'log'
                ? 'log'
                : options.targetAgentPath
                  ? 'agent:agent-2'
                  : 'agent:owner',
            turn:
              options.destination === 'log'
                ? { mode: 'none' }
                : { mode: 'coalesce', windowMs: 1000, maxBatch: 100 },
          },
        ],
      },
      actor
    );
    const request = {
      documentId,
      routeId: 'route',
      expiresAt: new Date(Date.parse(now) + 86400000).toISOString(),
    };
    let result = grants.grant(request, actor);
    if (result.kind === 'approval_required') {
      if (new ApprovalService(db).grant(result.ticket.approvalId) !== undefined)
        throw new Error('Approval should not bypass original matching-ticket consumption');
      result = grants.grant(request, actor, result.ticket.token);
    }
    if (result.kind !== 'granted') throw new Error('Expected actual route grant');
    const grantId = result.kind === 'granted' ? result.grant.grantId : '';
    const queue = new MessageQueueStore(db);
    const admission = new DocBatchAdmission({
      db,
      store,
      grants,
      lifecycle: documents.lifecycle,
      queue,
      bootEpoch,
      beforeClaim: options.nativeLedgerOnly
        ? documentRouteTurnBudget
        : createDocBeforeClaim(store, grants),
      now: clock,
    });
    admission.initializeBoot();
    const ingest = new DocChannelIngest(store, clock);
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
      get native() {
        return (native ??= consumeServerNativeRelayConstruction(
          opened.serverNativeRelayConstruction,
          db
        ));
      },
      serverNativeRelayConstruction: opened.serverNativeRelayConstruction,
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
  } catch (cause) {
    {
      try {
        db.$client.close();
      } catch {
        /* Preserve the original setup cause, including undefined. */
      }
    }
    throw cause;
  }
}
