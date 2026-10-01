import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents, sessionMetadata, createDb, runMigrations, type Db } from '@dorkos/db';
import { createRoomSubsystem, type RoomSubsystem } from '../../../rooms/index.js';
import { RoomRepoStore } from '../../../rooms/repo/room-repo-store.js';
import { ApprovalService } from '../../../core/approvals/approval-service.js';
import { linkSessionId, resetSessionKeys } from '../../../session/session-key-registry.js';
import { randomUUID } from 'node:crypto';
import { ConnectorRuntimePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { createDocChannelHttpComposition } from '../http-composition.js';

let db: Db;
let rooms: RoomSubsystem;
let approvals: ApprovalService;
let http: ReturnType<typeof createDocChannelHttpComposition>;
let documentId: string;
const actor = () => ({
  surface: 'http' as const,
  principal: createServerPrincipal({
    kind: 'operator',
    owner: { kind: 'local_install', installationId: 'test-install' },
  }),
});
beforeEach(() => {
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
        { id: 'other', on: 'task.*', to: 'agent:b', turn: { mode: 'immediate', maxBatch: 100 } },
      ],
    },
    actor(),
    'a'
  );
});
afterEach(() => {
  db.$client.close();
  resetSessionKeys();
});
const input = () => ({
  documentId,
  routeId: 'other',
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
});
describe('production explicit agent target binding', () => {
  it('consumes an operator approval bound to B while the document remains owned by A', () => {
    const request = input();
    const pending = http.grants.grant(request, actor());
    expect(pending.kind).toBe('approval_required');
    if (pending.kind !== 'approval_required') throw new Error('Expected approval');
    approvals.grant(pending.ticket.approvalId);
    const granted = http.grants.grant(request, actor(), pending.ticket.token);
    expect(granted.kind).toBe('granted');
    if (granted.kind !== 'granted') throw new Error('Expected grant');
    expect(granted.grant).toMatchObject({
      targetAgentId: 'b',
      targetSessionId: 'session-b',
      targetRuntime: 'codex',
    });
    expect(granted.grant.approvalEvidence).toMatchObject({
      binding: {
        scope: 'session:session-a',
        target: { agentId: 'b', agentPath: '/agents/b', runtime: 'codex', sessionId: 'session-b' },
      },
    });
    expect(
      db.$client
        .prepare('SELECT consumed_at FROM approvals WHERE id = ?')
        .get(pending.ticket.approvalId)
    ).toMatchObject({ consumed_at: expect.any(String) });
  });
  it('refuses runtime effects when the real binding is revoked during async revalidation', async () => {
    const principals = new ConnectorRuntimePrincipalService({
      db,
      authority: {
        authorizeTurn: async () => ({
          owner: { kind: 'local_install', installationId: 'test-install' },
          agentId: 'a',
        }),
        revalidateTurn: async () => true,
      },
    });
    await principals.initializeBoot();
    const opened = await principals.openTurn(
      {
        runtime: 'codex',
        canonicalSessionId: 'session-a',
        agentPath: '/agents/a',
        signal: new AbortController().signal,
      },
      { isCurrent: () => true }
    );
    const resolved = await principals.resolve({ bearer: opened.bearer, expectedRuntime: 'codex' });
    if (resolved.status !== 'resolved') throw new Error('Expected authenticated turn');
    const composition = createDocChannelHttpComposition({
      db,
      documents: rooms.canvasDocuments,
      rooms: rooms.service,
      roomStore: rooms.store,
      roomRepos: new RoomRepoStore(db, '/unused'),
      approvals,
      installationId: 'test-install',
      runtimePrincipalCurrent: (proof) => principals.isPrincipalCurrent(proof),
      revalidateRuntime: async (proof) => {
        await Promise.resolve();
        await principals.revoke(opened.bindingId, 'turn_cancelled');
        return principals.revalidatePrincipal(proof);
      },
    });
    const envelope = { v: 1, id: randomUUID(), type: 'task.changed', payload: {} };
    await expect(
      composition.service.ingestEvent(documentId, envelope, {
        surface: 'capability',
        principal: resolved.principal,
      })
    ).rejects.toMatchObject({ status: 404 });
    expect(composition.channels.getEvent(documentId, envelope.id)).toBeUndefined();
  });
  it('deduplicates server-known aliases before requiring one canonical candidate', () => {
    db.insert(sessionMetadata)
      .values({
        sessionId: 'old-b',
        agentPath: '/agents/b',
        runtime: 'codex',
        createdAt: new Date().toISOString(),
      })
      .run();
    linkSessionId('old-b', 'session-b');
    expect(http.grants.grant(input(), actor()).kind).toBe('approval_required');
  });
  it('refuses an ambiguous current execution session and does not select the newest', () => {
    db.insert(sessionMetadata)
      .values({
        sessionId: 'other-b',
        agentPath: '/agents/b',
        runtime: 'codex',
        createdAt: new Date().toISOString(),
      })
      .run();
    expect(() => http.grants.grant(input(), actor())).toThrow('TARGET_UNAVAILABLE');
  });
  it('refuses settlement if another current candidate appears after approval', () => {
    const request = input();
    const pending = http.grants.grant(request, actor());
    if (pending.kind !== 'approval_required') throw new Error('Expected approval');
    approvals.grant(pending.ticket.approvalId);
    db.insert(sessionMetadata)
      .values({
        sessionId: 'other-b',
        agentPath: '/agents/b',
        runtime: 'codex',
        createdAt: new Date().toISOString(),
      })
      .run();
    expect(() => http.grants.grant(request, actor(), pending.ticket.token)).toThrow(
      'TARGET_UNAVAILABLE'
    );
    expect(db.$client.prepare('SELECT count(*) AS n FROM canvas_doc_grants').get()).toEqual({
      n: 0,
    });
  });
});
