import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agents,
  sessionMetadata,
  eq,
  createDb,
  runMigrations,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import { createRoomSubsystem, setRoomService, type RoomSubsystem } from '../../../rooms/index.js';
import { controlUi } from '../../../session/browser-seat/ui-control.js';
import { uiTurnFacts } from '../../../session/browser-seat/ui-turn-facts.js';
import {
  createServerPrincipal,
  isServerPrincipal,
  type ConnectorRuntime,
} from '../../../connectors/principal/server-principal.js';
import { ApprovalService } from '../../../core/approvals/approval-service.js';
import {
  DocChannelAuthorization,
  DocChannelNotFoundError,
  type DocChannelActor,
} from '../authorization.js';
import { DocChannelStore } from '../store.js';
import { DocChannelGrants } from '../grants.js';
import { DocRouteGrantError } from '../grant-policy.js';
import { parseScope, SESSION_OWNER_AUTHOR } from '../../scopes.js';

vi.mock('../../../core/config-manager.js', () => ({ configManager: { get: vi.fn(() => null) } }));
vi.mock('../../../session/browser-seat/session-reach.js', () => ({ emitToSession: () => true }));
let db: Db;
let rooms: RoomSubsystem;
let channels: DocChannelStore;
let grants: DocChannelGrants;
const owner = { kind: 'local_install' as const, installationId: 'test-install' };
const declaration = {
  routes: [
    {
      id: 'tasks',
      on: 'task.*',
      to: 'agent:owner' as const,
      turn: { mode: 'coalesce' as const, windowMs: 1000, maxBatch: 100 },
    },
  ],
};
const content = { type: 'url' as const, url: 'https://example.test/app' };
function seed(id: string, runtime: ConnectorRuntime = 'claude-code') {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id,
      name: id,
      runtime,
      projectPath: `/agents/${id}`,
      registeredAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(sessionMetadata)
    .values({ sessionId: `session-${id}`, runtime, agentPath: `/agents/${id}`, createdAt: now })
    .run();
}
function actor(id: string, runtime: ConnectorRuntime = 'claude-code'): DocChannelActor {
  return {
    surface: 'capability',
    principal: createServerPrincipal({
      kind: 'runtime',
      owner,
      bindingId: `binding-${id}`,
      runtime,
      canonicalSessionId: `session-${id}`,
      agentId: id,
      agentPath: `/agents/${id}`,
    }),
  };
}
beforeEach(() => {
  db = createDb(':memory:');
  runMigrations(db);
  rooms = createRoomSubsystem({ db });
  setRoomService(rooms.service);
  channels = new DocChannelStore(db);
  uiTurnFacts.clear();
  const authorization = new DocChannelAuthorization(db, rooms.canvasDocuments, {
    ownsInstallation: (claims) =>
      claims.owner.kind === 'local_install' && claims.owner.installationId === owner.installationId,
    principalCurrent: (proof) => {
      if (!isServerPrincipal(proof) || proof.claims.kind !== 'runtime') return false;
      const claims = proof.claims;
      const agent = db.select().from(agents).where(eq(agents.id, claims.agentId)).get();
      const session = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, claims.canonicalSessionId))
        .get();
      return (
        agent?.status === 'active' &&
        agent.projectPath === claims.agentPath &&
        agent.runtime === claims.runtime &&
        session?.agentPath === claims.agentPath &&
        session.runtime === claims.runtime
      );
    },
    roomMembership: (roomId, claims) => {
      if (claims.kind !== 'runtime') return undefined;
      const author = rooms.authors.resolveAgent(claims.agentPath, claims.agentId);
      try {
        return rooms.service.requireMembership(roomId, author.id);
      } catch {
        return undefined;
      }
    },
  });
  grants = new DocChannelGrants({
    db,
    store: channels,
    approvals: new ApprovalService(db),
    authority: {
      resolveScope: (scope) => rooms.canvasDocuments.lifecycle.resolveScope(scope),
      requireCurrent: (id, caller, write, tx) =>
        authorization.requireCurrent(id, caller, write, tx),
      requireGrantedCurrent: () => {
        throw new DocRouteGrantError('BACKGROUND_NOT_ENABLED');
      },
      sourceRoot: () => null, // Fixtures are remote URL documents, with no local app root.
      originCurrent: (id, opener, tx) =>
        channels.getChannel(id, tx)?.openerAgentId === opener &&
        (tx ?? db).select().from(agents).where(eq(agents.id, opener)).get()?.status === 'active',
      resolveTarget: (input, tx?: DbTransaction) => {
        const agent = (tx ?? db)
          .select()
          .from(agents)
          .where(eq(agents.id, input.openerAgentId ?? ''))
          .get();
        if (!agent) throw new DocChannelNotFoundError();
        const scope = rooms.canvasDocuments.lifecycle.resolveScope(input.scope);
        const parsed = parseScope(scope);
        let sessionId = parsed.kind === 'session' ? parsed.id : null;
        if (parsed.kind === 'room') {
          const author = rooms.authors.resolveAgent(agent.projectPath, agent.name);
          rooms.service.requireMembership(parsed.id, author.id);
          sessionId = rooms.store.getRoomSession(parsed.id, author.id);
        }
        if (!sessionId) throw new DocChannelNotFoundError();
        const session = (tx ?? db)
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, sessionId))
          .get();
        if (session?.agentPath !== agent.projectPath || session.runtime !== agent.runtime)
          throw new DocChannelNotFoundError();
        return {
          agentId: agent.id,
          agentPath: agent.projectPath,
          sessionId,
          runtime: session.runtime,
          scope,
        };
      },
    },
  });
});
afterEach(() => {
  uiTurnFacts.clear();
  db.$client.close();
  vi.restoreAllMocks();
});

describe('common canvas open origin binding', () => {
  it.each(['claude-code', 'codex', 'opencode'] as const)(
    'records the bound %s opener and declaration through actual control_ui, then permits only its self grant',
    async (runtime) => {
      seed('one', runtime);
      const result = await controlUi(
        { action: 'open_canvas', content, channel: declaration },
        { sessionId: 'session-one', principal: actor('one', runtime).principal }
      );
      const id = result.documentId as string;
      expect(channels.getChannel(id)).toMatchObject({ openerAgentId: 'one', declaration });
      expect(channels.getChannel(id)?.declarationHash).toMatch(/^[a-f0-9]{64}$/);
      const granted = grants.grant(
        {
          documentId: id,
          routeId: 'tasks',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
        actor('one', runtime)
      );
      expect(granted.kind).toBe('granted');
      if (granted.kind === 'granted')
        expect(granted.grant).toMatchObject({
          approvedBy: 'one',
          openerAgentId: 'one',
          targetAgentId: 'one',
        });
    }
  );
  it('keeps a human-opened origin null even when a later runtime refreshes the same document', async () => {
    seed('one');
    const opened = rooms.canvas.open('session:session-one', SESSION_OWNER_AUTHOR, content, {
      channel: declaration,
    });
    expect(channels.getChannel(opened.id)?.openerAgentId).toBeNull();
    await controlUi(
      { action: 'open_canvas', content, channel: declaration },
      { sessionId: 'session-one', principal: actor('one').principal }
    );
    expect(channels.getChannel(opened.id)?.openerAgentId).toBeNull();
    expect(() =>
      grants.grant(
        {
          documentId: opened.id,
          routeId: 'tasks',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
        actor('one')
      )
    ).toThrow(DocRouteGrantError);
  });
  it('preserves the original room opener when another verified occupant refreshes the content', async () => {
    seed('one');
    seed('two');
    const human = rooms.authors.localHuman().id;
    const room = rooms.service.createRoom(
      { kind: 'channel', title: 'Shared', members: [], agentPaths: ['/agents/one', '/agents/two'] },
      human
    );
    const first = rooms.authors.resolveAgent('/agents/one', 'one');
    const second = rooms.authors.resolveAgent('/agents/two', 'two');
    rooms.store.bindRoomSession(room.id, first.id, 'session-one', new Date().toISOString());
    rooms.store.bindRoomSession(room.id, second.id, 'session-two', new Date().toISOString());
    uiTurnFacts.bindTurn('session-one', {
      roomTurn: { roomId: room.id, authorId: first.id, turnId: 'first' },
    });
    const opened = await controlUi(
      { action: 'open_canvas', content, channel: declaration },
      { sessionId: 'session-one', principal: actor('one').principal }
    );
    const id = opened.documentId as string;
    expect(channels.getChannel(id)?.openerAgentId).toBe('one');
    uiTurnFacts.bindTurn('session-two', {
      roomTurn: { roomId: room.id, authorId: second.id, turnId: 'second' },
    });
    await controlUi(
      {
        action: 'open_canvas',
        content: { ...content, title: 'Changed by two' },
        channel: declaration,
      },
      { sessionId: 'session-two' }
    );
    expect(channels.getChannel(id)?.openerAgentId).toBe('one');
    const own = grants.grant(
      { documentId: id, routeId: 'tasks', expiresAt: new Date(Date.now() + 3600000).toISOString() },
      actor('one')
    );
    expect(own.kind).toBe('granted');
    expect(() => grants.configure(id, { routes: [] }, actor('two'))).toThrow(DocRouteGrantError);
  });
  it('does not derive an opener from page options, an unbound session or a stale occupant', async () => {
    seed('one');
    const result = await controlUi(
      {
        action: 'open_canvas',
        content,
        channel: declaration,
        forAgent: 'one',
        openerAgentId: 'one',
      },
      { sessionId: 'unknown-session' }
    );
    expect(channels.getChannel(result.documentId as string)?.openerAgentId).toBeNull();
    db.update(agents).set({ status: 'inactive' }).where(eq(agents.id, 'one')).run();
    const stale = rooms.canvas.open(
      'session:session-one',
      'agent',
      { ...content, url: 'https://example.test/stale' },
      { channel: declaration }
    );
    expect(channels.getChannel(stale.id)?.openerAgentId).toBeNull();
  });
  it('refuses a previously valid runtime proof after its current session binding changes', async () => {
    seed('one');
    seed('two');
    const stale = actor('one').principal;
    db.update(sessionMetadata)
      .set({ agentPath: '/agents/two' })
      .where(eq(sessionMetadata.sessionId, 'session-one'))
      .run();
    const result = await controlUi(
      { action: 'open_canvas', content },
      { sessionId: 'session-one', principal: stale }
    );
    expect(channels.getChannel(result.documentId as string)?.openerAgentId).toBeNull();
  });

  it('rolls back both the physical row and origin when initialization fails', () => {
    seed('one');
    const before = rooms.canvas.list('session:session-one').length;
    db.$client.exec(
      "CREATE TRIGGER fail_channel_open BEFORE INSERT ON canvas_doc_channels BEGIN SELECT RAISE(ABORT,'forced'); END;"
    );
    try {
      expect(() =>
        rooms.canvas.open('session:session-one', 'agent', content, { channel: declaration })
      ).toThrow();
      expect(rooms.canvas.list('session:session-one')).toHaveLength(before);
    } finally {
      db.$client.exec('DROP TRIGGER fail_channel_open');
    }
  });
});
