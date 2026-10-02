/** Public readiness derives from actual current grants, never declaration or queue text alone. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  agents,
  and,
  canvasDocChannels,
  eq,
  roomMembers,
  rooms,
  sessionMetadata,
  type Db,
} from '@dorkos/db';
import type { CanvasChannelRoute } from '@dorkos/shared/canvas-channel-schemas';
import { ApprovalService } from '../../../core/approvals/approval-service.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { resetSessionKeys } from '../../../session/session-key-registry.js';
import { DocChannelAuthorization, DocChannelNotFoundError } from '../authorization.js';
import { DocChannelGrants } from '../grants.js';
import { DocRouteGrantError, type DocGrantAuthority } from '../grant-policy.js';
import { DocChannelIngest } from '../ingest.js';
import { DocChannelService } from '../service.js';
import { batchFixture, FROM, NOW, TO } from './batch-fixtures.js';

const databases: Db[] = [];
afterEach(() => {
  resetSessionKeys();
  for (const db of databases.splice(0)) if (db.$client.open) db.$client.close();
});
const route: CanvasChannelRoute = {
  id: 'route',
  on: 'task.*',
  to: 'agent:owner',
  turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 100 },
};

function fixture(room = false) {
  const f = batchFixture();
  databases.push(f.db);
  f.grants.revoke(f.documentId, f.grantId, f.actor);
  let clock = new Date(NOW);
  let viewerCurrent = true;
  let originCurrent = true;
  let targetSession: string | undefined;
  const viewer = {
    surface: 'http' as const,
    principal: createServerPrincipal({
      kind: 'operator',
      owner: {
        kind: 'local_install',
        installationId: 'installation',
      },
    }),
  };
  if (room) {
    f.db
      .insert(rooms)
      .values({
        id: 'room-1',
        kind: 'channel',
        title: 'Test room',
        createdAt: NOW,
        lastActivityAt: NOW,
      })
      .run();
    f.db
      .insert(roomMembers)
      .values(
        ['agent-1', 'viewer'].map((authorId) => ({
          roomId: 'room-1',
          authorId,
          responseMode: 'engaged',
          joinedAt: NOW,
        }))
      )
      .run();
  }
  const documentId = room
    ? f.canvas.open('room:room-1', 'agent-1', {
        type: 'markdown',
        title: 'Room tasks',
        content: 'private-body',
      }).id
    : f.documentId;
  if (room)
    f.db
      .update(canvasDocChannels)
      .set({ openerAgentId: 'agent-1' })
      .where(eq(canvasDocChannels.documentId, documentId))
      .run();
  const authorization = new DocChannelAuthorization(f.db, f.documents, {
    ownsInstallation: (claims) =>
      claims.owner.kind === 'local_install' && claims.owner.installationId === 'installation',
    principalCurrent: (proof) =>
      proof === f.actor.principal || (proof === viewer.principal && viewerCurrent),
    roomMembership: (id, claims) => {
      const authorId =
        claims.kind === 'operator' ? 'viewer' : 'agentId' in claims ? claims.agentId : '';
      const member = f.db
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, id), eq(roomMembers.authorId, authorId)))
        .get();
      const currentRoom = f.db.select().from(rooms).where(eq(rooms.id, id)).get();
      return member && currentRoom ? { archived: currentRoom.archived } : undefined;
    },
  });
  const authority: DocGrantAuthority = {
    ...f.authority,
    requireCurrent: (id, actor, write, tx) => authorization.requireCurrent(id, actor, write, tx),
    requireGrantedCurrent: (grant, tx) => {
      if (!room) return f.authority.requireGrantedCurrent(grant, tx);
      const origin = (
        grant.approvalEvidence as {
          binding: { origin: { owner: { kind: string; installationId: string } } };
        }
      ).binding.origin;
      if (origin.owner.kind !== 'local_install' || origin.owner.installationId !== 'installation')
        throw new DocRouteGrantError('ACCESS_LOST');
      return authorization.requireCurrent(grant.documentId, f.actor, false, tx);
    },
    originCurrent: (id, opener, tx) => originCurrent && f.authority.originCurrent(id, opener, tx),
    resolveTarget: ({ scope, route: selected, openerAgentId }, tx) => {
      if (selected.to === 'log')
        return { scope, agentId: null, sessionId: null, runtime: null, agentPath: null };
      const agentId =
        selected.to === 'agent:owner' || selected.to === 'room:self'
          ? openerAgentId!
          : selected.to.slice('agent:'.length);
      const sessionId =
        agentId === 'agent-1'
          ? (targetSession ?? (scope.startsWith('session:') ? scope.slice(8) : 'session-1'))
          : 'other-session';
      const executor = tx ?? f.db;
      const agent = executor.select().from(agents).where(eq(agents.id, agentId)).get();
      const session = executor
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, sessionId))
        .get();
      if (
        !agent ||
        agent.status !== 'active' ||
        !session ||
        agent.projectPath !== session.agentPath ||
        agent.runtime !== session.runtime
      )
        throw new DocRouteGrantError('TARGET_IDENTITY_CHANGED');
      return { scope, agentId, sessionId, runtime: session.runtime, agentPath: session.agentPath };
    },
  };
  const approvals = new ApprovalService(f.db);
  const grants = new DocChannelGrants({
    db: f.db,
    store: f.store,
    authority,
    approvals,
    now: () => clock,
  });
  const service = new DocChannelService(f.documents, f.store, authorization, {
    grants,
    ingest: new DocChannelIngest(f.store, () => clock),
  });
  function configure(selected = route) {
    grants.configure(documentId, { routes: [selected] }, f.actor);
  }
  function grant(allowedTypes = ['task.toggle', 'task.comment']) {
    const request = {
      documentId,
      routeId: 'route',
      allowedTypes,
      expiresAt: new Date(clock.getTime() + 3600_000).toISOString(),
    };
    let result = grants.grant(request, f.actor);
    if (result.kind === 'approval_required') {
      expect(approvals.grant(result.ticket.approvalId)).toBeUndefined();
      result = grants.grant(request, f.actor, result.ticket.token);
    }
    if (result.kind !== 'granted') throw new Error('Expected actual grant');
    return result.grant;
  }
  return {
    ...f,
    documentId,
    viewer,
    grants,
    service,
    configure,
    grant,
    replay: () => service.replay(documentId, viewer),
    expire: () => {
      clock = new Date(clock.getTime() + 3600_000);
    },
    revokeViewer: () => {
      viewerCurrent = false;
    },
    revokeOrigin: () => {
      originCurrent = false;
    },
    useTargetAlias: (id: string) => {
      targetSession = id;
    },
  };
}

describe('document routing readiness', () => {
  it('projects an actual widget wildcard grant without expanding its approved pattern', async () => {
    const f = fixture();
    f.configure({ ...route, on: 'widget.*' });
    f.grant(['widget.*']);
    expect((await f.replay()).routing).toEqual({
      enabled: true,
      approvedEventTypes: ['widget.*'],
      destinationLabel: 'This document’s agent',
    });
    expect(f.queue.list('session-1')).toEqual([]);
  });

  it('summarizes only approved owning-session types without leaking grant paths, hashes or evidence', async () => {
    const f = fixture();
    f.configure();
    const approved = f.grant();
    const replay = await f.replay();
    expect(replay.routing).toEqual({
      enabled: true,
      approvedEventTypes: ['task.comment', 'task.toggle'],
      destinationLabel: 'This document’s agent',
    });
    const serialized = JSON.stringify(replay);
    for (const privateValue of [
      '/agents/one',
      approved.grantId,
      approved.routeHash,
      approved.declarationHash,
      'approvalEvidence',
      'originAuthorityDigest',
      'bindingId',
      'agentPath',
    ])
      expect(serialized).not.toContain(privateValue);
    expect(replay.highWatermark).toBe(0);
    expect(f.queue.list('session-1')).toEqual([]);
  });

  it('keeps an approved log route ready without advertising an agent turn', async () => {
    const f = fixture();
    f.configure({ ...route, to: 'log', turn: { mode: 'none' } });
    f.grant(['task.comment']);
    expect((await f.replay()).routing).toEqual({
      enabled: true,
      approvedEventTypes: ['task.comment'],
      destinationLabel: 'Saved in this document',
    });
  });

  it('does not turn an unapproved declaration or later revoked grant into readiness', async () => {
    const f = fixture();
    f.configure();
    expect((await f.replay()).routing).toMatchObject({ enabled: false, approvedEventTypes: [] });
    const approved = f.grant();
    expect((await f.replay()).routing?.enabled).toBe(true);
    f.grants.revoke(f.documentId, approved.grantId, f.actor);
    expect((await f.replay()).routing).toMatchObject({ enabled: false, approvedEventTypes: [] });
  });

  it('preserves readiness through a durable owning-session canonical move', async () => {
    const f = fixture();
    f.configure();
    f.grant();
    expect(f.documents.rekeyScope(FROM, TO)).toBe(1);
    resetSessionKeys();
    expect((await f.replay()).routing?.enabled).toBe(true);
  });

  it('recognizes a verified target alias of the owning session without in-memory queue aliases', async () => {
    const f = fixture();
    expect(f.documents.rekeyScope(FROM, TO)).toBe(1);
    f.useTargetAlias('session-1');
    f.configure();
    const approved = f.grant();
    expect(approved.targetSessionId).toBe('session-1');
    const current = f.grants.getCurrentRoutes(f.documentId, undefined, f.viewer);
    expect(current[0]).toMatchObject({ grantId: approved.grantId, targetSessionId: 'session-1' });
    expect(current[0]).not.toHaveProperty('reason');
    resetSessionKeys();
    expect((await f.replay()).routing?.enabled).toBe(true);
  });

  it('keeps an actually approved cross-target route disabled until its transport gate lands', async () => {
    const f = fixture();
    f.db.$client
      .prepare(
        'INSERT INTO agents (id,name,runtime,project_path,registered_at,updated_at) VALUES (?,?,?,?,?,?)'
      )
      .run('agent-2', 'two', 'claude-code', '/agents/two', NOW, NOW);
    f.db
      .insert(sessionMetadata)
      .values({
        sessionId: 'other-session',
        runtime: 'claude-code',
        agentPath: '/agents/two',
        createdAt: NOW,
      })
      .run();
    f.configure({ ...route, to: 'agent:agent-2' });
    const approved = f.grant();
    expect(approved.approvalId).not.toBeNull();
    expect(f.grants.getCurrentRoutes(f.documentId, undefined, f.viewer)[0]).toMatchObject({
      grantId: approved.grantId,
      targetSessionId: 'other-session',
    });
    expect((await f.replay()).routing).toMatchObject({ enabled: false, approvedEventTypes: [] });
  });

  it('keeps an actually approved room route disabled until room admission is available', async () => {
    const f = fixture(true);
    f.configure({ ...route, to: 'room:self' });
    const approved = f.grant();
    expect(approved.approvalId).not.toBeNull();
    expect(f.grants.getCurrentRoutes(f.documentId, undefined, f.viewer)[0]).toMatchObject({
      grantId: approved.grantId,
    });
    expect((await f.replay()).routing).toMatchObject({ enabled: false, approvedEventTypes: [] });
  });

  it.each(['expiry', 'origin', 'target'] as const)(
    'disables a grant after current %s authority stops permitting it',
    async (cause) => {
      const f = fixture();
      f.configure();
      f.grant();
      expect((await f.replay()).routing?.enabled).toBe(true);
      if (cause === 'expiry') f.expire();
      else if (cause === 'origin') f.revokeOrigin();
      else
        f.db
          .update(sessionMetadata)
          .set({ agentPath: '/agents/private-moved' })
          .where(eq(sessionMetadata.sessionId, 'session-1'))
          .run();
      expect((await f.replay()).routing).toMatchObject({ enabled: false, approvedEventTypes: [] });
    }
  );

  it('refuses even the readiness summary once the viewer principal is no longer current', async () => {
    const f = fixture();
    f.configure();
    f.grant();
    f.revokeViewer();
    await expect(f.replay()).rejects.toBeInstanceOf(DocChannelNotFoundError);
  });
});
