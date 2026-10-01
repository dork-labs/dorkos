import { afterEach, describe, expect, it, vi } from 'vitest';
import { agents, eq, sessionMetadata, type Db } from '@dorkos/db';
import {
  createServerPrincipal,
  type ServerPrincipalClaims,
} from '../../../connectors/principal/server-principal.js';
import {
  DocChannelAuthorization,
  DocChannelNotFoundError,
  type DocChannelActor,
  type DocChannelAuthorityPorts,
} from '../authorization.js';
import { DocChannelService } from '../service.js';
import { DocChannelStore } from '../store.js';
import { FROM, harness, seedAuthority } from './lifecycle-fixtures.js';
import { createRoomHarness, agentLookupFor } from '../../../rooms/__tests__/room-test-harness.js';

const connections: Db[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of connections.splice(0)) db.$client.close();
});
const owner = { kind: 'local_install', installationId: 'installation' } as const;
const claims = {
  kind: 'runtime',
  owner,
  bindingId: 'binding',
  runtime: 'claude-code',
  canonicalSessionId: 'session-1',
  agentId: 'agent-1',
  agentPath: '/agents/one',
} as const;
function actor(overrides: Partial<typeof claims> = {}): DocChannelActor {
  return { surface: 'capability', principal: createServerPrincipal({ ...claims, ...overrides }) };
}
function ports(extra: Partial<DocChannelAuthorityPorts> = {}): DocChannelAuthorityPorts {
  return {
    ownsInstallation: (value) =>
      value.owner.kind === 'local_install'
        ? value.owner.installationId === owner.installationId
        : value.owner.userId === 'signed-owner',
    roomMembership: () => undefined,
    principalCurrent: () => true,
    ...extra,
  };
}
function setup(extra: Partial<DocChannelAuthorityPorts> = {}) {
  const h = harness();
  connections.push(h.db);
  const doc = h.canvas.open(FROM, 'agent', { type: 'file', sourcePath: '/private/tasks.md' });
  const authorization = new DocChannelAuthorization(h.db, h.documents, ports(extra));
  return {
    ...h,
    doc,
    authorization,
    service: new DocChannelService(h.documents, h.store, authorization),
  };
}

describe('private document scope authority', () => {
  it('returns the current canonical write identity after rekey during asynchronous authority', async () => {
    const h = setup();
    const original = h.authorization.require.bind(h.authorization);
    vi.spyOn(h.authorization, 'require').mockImplementation(async (...args) => {
      const identity = await original(...args);
      queueMicrotask(() => h.documents.rekeyScope(FROM, 'session:canonical'));
      return identity;
    });
    expect(await h.service.requireWrite(h.doc.id, actor())).toEqual({
      id: h.doc.id,
      scope: 'session:canonical',
    });
    expect(h.store.getChannel(h.doc.id)?.scope).toBe('session:canonical');
  });

  it('refuses a runtime proof when live principal authority is not wired', () => {
    const h = setup({ principalCurrent: undefined });
    expect(() => h.authorization.requireCurrent(h.doc.id, actor())).toThrow(
      DocChannelNotFoundError
    );
  });
  it.each(['login-off', 'login-on'])('allows verified human ownership with %s', async (mode) => {
    const h = setup();
    const principal = createServerPrincipal({
      kind: 'operator',
      owner: mode === 'login-on' ? { kind: 'user', userId: 'signed-owner' } : owner,
    });
    expect(await h.service.readChannel(h.doc.id, { surface: 'http', principal })).toMatchObject({
      documentId: h.doc.id,
      scope: FROM,
    });
  });
  it('exposes only operator recovery health while collision blocks retained channel reads', async () => {
    const h = setup();
    h.canvas.open('session:canonical', 'agent', { type: 'file', sourcePath: '/private/tasks.md' });
    expect(() => h.documents.rekeyScope(FROM, 'session:canonical')).toThrow();
    const human: DocChannelActor = {
      surface: 'http',
      principal: createServerPrincipal({ kind: 'operator', owner }),
    };
    expect(h.service.readHealth(h.doc.id, human)).toEqual({
      status: 'in_doubt',
      reasons: ['identity_move_failed'],
    });
    await expect(h.service.readChannel(h.doc.id, human)).rejects.toMatchObject({ status: 404 });
    expect(() => h.service.readHealth(h.doc.id, actor())).toThrow(DocChannelNotFoundError);
    expect(() => h.service.readHealth('absent', human)).toThrow(DocChannelNotFoundError);
  });
  it('preserves the people-only session HTTP boundary for a verified agent', async () => {
    const h = setup();
    await expect(
      h.service.readChannel(h.doc.id, { ...actor(), surface: 'http' })
    ).rejects.toMatchObject({ status: 404 });
    expect(await h.service.readChannel(h.doc.id, actor())).toMatchObject({ documentId: h.doc.id });
  });
  it('refuses forged, sessionless, unrelated and wrong-owner principals without channel reads', async () => {
    const h = setup();
    const read = vi.spyOn(h.store, 'getChannel');
    const denied: DocChannelActor[] = [
      { surface: 'capability', principal: JSON.parse(JSON.stringify(actor().principal)) },
      {
        surface: 'capability',
        principal: createServerPrincipal({
          kind: 'agent',
          owner,
          agentId: 'agent-1',
          agentPath: '/agents/one',
        }),
      },
      {
        surface: 'capability',
        principal: createServerPrincipal({ ...claims, canonicalSessionId: 'another' }),
      },
      {
        surface: 'http',
        principal: createServerPrincipal({
          kind: 'operator',
          owner: { kind: 'user', userId: 'stranger' },
        }),
      },
    ];
    for (const caller of denied)
      await expect(h.service.readChannel(h.doc.id, caller)).rejects.toBeInstanceOf(
        DocChannelNotFoundError
      );
    expect(read).not.toHaveBeenCalled();
    await expect(h.service.readChannel('missing', actor())).rejects.toMatchObject({
      status: 404,
      code: 'CANVAS_DOCUMENT_NOT_FOUND',
    });
  });
  it.each(['runtime', 'path', 'inactive'] as const)(
    'rechecks changed %s before disclosure and inside a transaction',
    async (change) => {
      const h = setup();
      if (change === 'runtime')
        h.db
          .update(sessionMetadata)
          .set({ runtime: 'codex' })
          .where(eq(sessionMetadata.sessionId, 'session-1'))
          .run();
      if (change === 'path')
        h.db
          .update(sessionMetadata)
          .set({ agentPath: '/another' })
          .where(eq(sessionMetadata.sessionId, 'session-1'))
          .run();
      if (change === 'inactive')
        h.db.update(agents).set({ status: 'inactive' }).where(eq(agents.id, 'agent-1')).run();
      await expect(h.service.readChannel(h.doc.id, actor())).rejects.toMatchObject({ status: 404 });
      expect(() =>
        h.db.transaction((tx) => h.authorization.requireCurrent(h.doc.id, actor(), true, tx))
      ).toThrow(DocChannelNotFoundError);
    }
  );
  it.each(['binding', 'close'] as const)(
    'refuses a %s changed during asynchronous runtime revalidation',
    async (change) => {
      const h = setup();
      const read = vi.spyOn(h.store, 'getChannel');
      const authorization = new DocChannelAuthorization(
        h.db,
        h.documents,
        ports({
          revalidateRuntime: async () => {
            if (change === 'binding')
              h.db
                .update(sessionMetadata)
                .set({ runtime: 'codex' })
                .where(eq(sessionMetadata.sessionId, 'session-1'))
                .run();
            else h.canvas.close(FROM, h.doc.id);
            return true;
          },
        })
      );
      const service = new DocChannelService(h.documents, h.store, authorization);
      await expect(service.readChannel(h.doc.id, actor())).rejects.toMatchObject({ status: 404 });
      expect(read).not.toHaveBeenCalled();
    }
  );
  it('follows only durable canonical aliases after a successful move', async () => {
    const h = setup();
    h.documents.rekeyScope(FROM, 'session:canonical');
    expect(await h.service.readChannel(h.doc.id, actor())).toMatchObject({
      scope: 'session:canonical',
    });
  });
  it('does not expose tombstone state through an old ID after reopening its source', async () => {
    const h = setup();
    h.canvas.close(FROM, h.doc.id);
    const newDoc = h.canvas.open(FROM, 'agent', { type: 'file', sourcePath: '/private/tasks.md' });
    await expect(h.service.readChannel(h.doc.id, actor())).rejects.toMatchObject({ status: 404 });
    expect(await h.service.readChannel(newDoc.id, actor())).toMatchObject({
      nextDocSeq: 1,
      state: {},
    });
  });
  it('rechecks a revoked live principal at the final synchronous gate', async () => {
    let current = true;
    const h = setup({ principalCurrent: () => current });
    await h.authorization.require(h.doc.id, actor());
    current = false;
    expect(() =>
      h.db.transaction((tx) => h.authorization.requireCurrent(h.doc.id, actor(), true, tx))
    ).toThrow(DocChannelNotFoundError);
  });
});

describe('current real room membership', () => {
  function roomSetup() {
    const rooms = createRoomHarness({
      agents: agentLookupFor({
        '/agents/one': { name: 'one', displayName: 'One', responseMode: 'always' },
      }),
    });
    connections.push(rooms.db);
    seedAuthority(rooms.db);
    const room = rooms.service.createRoom(
      { kind: 'channel', title: 'Private', members: [], agentPaths: ['/agents/one'] },
      rooms.human
    );
    const doc = rooms.service.canvas.open(room.id, rooms.human, {
      type: 'json',
      data: { private: true },
    });
    const roomPorts = ports({
      roomMembership: (id, principal: ServerPrincipalClaims) => {
        const author =
          principal.kind === 'operator'
            ? rooms.human
            : principal.kind === 'runtime' || principal.kind === 'agent'
              ? rooms.authors.resolveAgent(principal.agentPath, 'One').id
              : 'stranger';
        try {
          return rooms.service.requireMembership(id, author);
        } catch {
          return undefined;
        }
      },
    });
    const authorization = new DocChannelAuthorization(rooms.db, rooms.canvasDocuments, roomPorts);
    const store = new DocChannelStore(rooms.db);
    return {
      ...rooms,
      room,
      doc,
      roomPorts,
      authorization,
      service: new DocChannelService(rooms.canvasDocuments, store, authorization),
    };
  }
  it('allows members, refuses lost membership and preserves archived read/write behavior', async () => {
    const h = roomSetup();
    const caller = actor();
    await expect(h.service.readChannel(h.doc.id, caller)).resolves.toMatchObject({
      scope: `room:${h.room.id}`,
    });
    h.db.$client.prepare('UPDATE rooms SET archived = 1 WHERE id = ?').run(h.room.id);
    await expect(h.service.readChannel(h.doc.id, caller)).resolves.toBeDefined();
    await expect(h.service.requireWrite(h.doc.id, caller)).rejects.toMatchObject({
      code: 'ROOM_ARCHIVED',
    });
    const member = h.authors.resolveAgent('/agents/one', 'One').id;
    h.db.$client
      .prepare('DELETE FROM room_members WHERE room_id = ? AND author_id = ?')
      .run(h.room.id, member);
    await expect(h.service.readChannel(h.doc.id, caller)).rejects.toMatchObject({ status: 404 });
  });
  it('refuses membership lost during awaited runtime revalidation without retained data', async () => {
    const h = roomSetup();
    const member = h.authors.resolveAgent('/agents/one', 'One').id;
    const authorization = new DocChannelAuthorization(h.db, h.canvasDocuments, {
      ...h.roomPorts,
      revalidateRuntime: async () => {
        h.db.$client
          .prepare('DELETE FROM room_members WHERE room_id = ? AND author_id = ?')
          .run(h.room.id, member);
        return true;
      },
    });
    await expect(authorization.require(h.doc.id, actor())).rejects.toMatchObject({ status: 404 });
    expect(() =>
      h.db.transaction((tx) => authorization.requireCurrent(h.doc.id, actor(), true, tx))
    ).toThrow(DocChannelNotFoundError);
  });
});
