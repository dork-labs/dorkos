/**
 * `GET /api/team` over HTTP — the envelope, the status codes, and the two
 * things that must never be true of this route: that it writes, and that a
 * failed source turns into a failed request (ADR 260806-222535).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { MemberRoomsResponseSchema, TeamRosterResponseSchema } from '@dorkos/shared/team-schemas';
import { authors } from '@dorkos/db';
import { AuthorRegistry } from '../../services/rooms/author-registry.js';
import { RoomStore } from '../../services/rooms/room-store.js';
import { createTeamRouter, type TeamMeshReader, type TeamRouterDeps } from '../team.js';
import type { TeamAgentSource } from '../../services/identity/aggregate-team.js';

const OWNER_USER_ID = 'user-1';

const ANA: TeamAgentSource = {
  id: 'agent-ana',
  name: 'ana',
  displayName: 'Ana',
  runtime: 'claude-code',
  registeredAt: '2026-08-01T00:00:00.000Z',
  healthStatus: 'active',
};

const DORKBOT: TeamAgentSource = {
  id: 'agent-dorkbot',
  name: 'dorkbot',
  displayName: 'DorkBot',
  runtime: 'claude-code',
  isSystem: true,
  registeredAt: '2026-07-01T00:00:00.000Z',
  healthStatus: 'stale',
};

describe('GET /api/team', () => {
  let db: Db;
  let registry: AuthorRegistry;
  let rooms: RoomStore;
  let ownerAuthorId: string;

  function app(overrides: Partial<TeamRouterDeps> = {}) {
    const mesh: TeamMeshReader = { listWithHealth: () => [ANA, DORKBOT] };
    const server = express();
    server.use(
      '/api/team',
      createTeamRouter({
        authors: registry,
        rooms,
        meshCore: mesh,
        ownerAccount: () => ({ id: OWNER_USER_ID, name: 'Dorian' }),
        ownerEmail: () => 'dorian@dorkos.ai',
        configDisplayName: () => null,
        defaultAgentName: () => 'ana',
        ...overrides,
      })
    );
    return server;
  }

  beforeEach(() => {
    db = createTestDb();
    registry = new AuthorRegistry(db);
    rooms = new RoomStore(db);
    ownerAuthorId = registry.bindOwner(OWNER_USER_ID).id;
  });

  it('serves one roster of people and agents', async () => {
    const res = await request(app()).get('/api/team');

    expect(res.status).toBe(200);
    expect(TeamRosterResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.members.map((m: { id: string }) => m.id)).toEqual([
      ownerAuthorId,
      'agent-ana',
      'agent-dorkbot',
    ]);
    expect(res.body.warnings).toBeUndefined();
  });

  it('names the operator and marks their row as the self row', async () => {
    const res = await request(app()).get('/api/team');
    const self = res.body.members.find((m: { isSelf: boolean }) => m.isSelf);

    expect(self.displayName).toBe('Dorian');
    expect(self.person.email).toBe('dorian@dorkos.ai');
  });

  it('answers 200 with a warning when the mesh read throws', async () => {
    const res = await request(
      app({
        meshCore: {
          listWithHealth: () => {
            throw new Error('mesh registry unavailable');
          },
        },
      })
    ).get('/api/team');

    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(1);
    expect(res.body.warnings).toEqual([{ source: 'agents', message: 'mesh registry unavailable' }]);
  });

  it('answers 200 with a warning when the mesh never started', async () => {
    const res = await request(app({ meshCore: undefined })).get('/api/team');

    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(1);
    expect(res.body.warnings?.[0]?.source).toBe('agents');
  });

  it('claims nobody as the operator when a bound install loses its account row', async () => {
    // The defensive case, not the common one: this install HAS been bound to an
    // account (`bindOwner` ran in setup), and then the account row went missing.
    // Nothing matches `'local'` any more, so the roster honestly claims no self
    // rather than promoting whoever happens to be first. The ordinary
    // no-account install — the `'local'` sentinel, never bound — is covered in
    // `aggregate-team.test.ts` under "a fresh install that has never had an
    // account", where `isSelf` IS true.
    const res = await request(app({ ownerAccount: () => null })).get('/api/team');

    expect(res.status).toBe(200);
    expect(res.body.members[0]?.displayName).toBe('You');
    expect(res.body.members[0]?.isSelf).toBe(false);
  });

  describe('no read can 500 the roster', () => {
    // Each of these was a 500 before the degradation envelope covered every
    // read, not just the two registries. The contract is that a roster which
    // cannot say your name still lists your agents.
    const boom = () => {
      throw new Error('boom');
    };

    it.each([
      ['the owner-account lookup', { ownerAccount: boom }, 'operator'],
      ['the owner-email lookup', { ownerEmail: boom }, 'operator'],
      ['the profile display name', { configDisplayName: boom }, 'config'],
      ['the default-agent setting', { defaultAgentName: boom }, 'config'],
    ])('answers 200 when %s throws', async (_label, override, source) => {
      const res = await request(app(override as Partial<TeamRouterDeps>)).get('/api/team');

      expect(res.status).toBe(200);
      // The roster is whole: one person plus both agents.
      expect(res.body.members).toHaveLength(3);
      expect(res.body.warnings?.[0]?.source).toBe(source);
    });

    it('still names the operator when only the email lookup throws', async () => {
      const res = await request(app({ ownerEmail: boom })).get('/api/team');
      // The account read failed as a whole, so the name falls to the next rung
      // rather than to a half-built account object.
      expect(res.body.members.find((m: { isSelf: boolean }) => m.isSelf)).toBeUndefined();
      expect(res.body.members[0]?.displayName).toBe('You');
    });
  });

  it('has no write path', async () => {
    const server = app();
    expect((await request(server).post('/api/team').send({ id: 'x' })).status).toBe(404);
    expect((await request(server).patch('/api/team/x').send({})).status).toBe(404);
    expect((await request(server).delete('/api/team/x')).status).toBe(404);
  });
});

describe('GET /api/team/:memberId/rooms', () => {
  let db: Db;
  let registry: AuthorRegistry;
  let rooms: RoomStore;
  let ownerAuthorId: string;

  function app(overrides: Partial<TeamRouterDeps> = {}) {
    const mesh: TeamMeshReader = { listWithHealth: () => [ANA, DORKBOT] };
    const server = express();
    server.use(
      '/api/team',
      createTeamRouter({
        authors: registry,
        rooms,
        meshCore: mesh,
        ownerAccount: () => ({ id: OWNER_USER_ID, name: 'Dorian' }),
        ownerEmail: () => 'dorian@dorkos.ai',
        configDisplayName: () => null,
        defaultAgentName: () => 'ana',
        ...overrides,
      })
    );
    return server;
  }

  /** The author row an agent gets the first time it is in a room. */
  function agentAuthor(id: string, path: string, manifestId: string): string {
    db.insert(authors)
      .values({
        id,
        kind: 'agent',
        naturalKey: path,
        displayName: id,
        mintedForManifestId: manifestId,
        createdAt: '2026-08-01T00:00:00.000Z',
      })
      .run();
    return id;
  }

  beforeEach(() => {
    db = createTestDb();
    registry = new AuthorRegistry(db);
    rooms = new RoomStore(db);
    ownerAuthorId = registry.bindOwner(OWNER_USER_ID).id;
    const anaAuthorId = agentAuthor('author-ana', '/work/ana', ANA.id);
    const dorkbotAuthorId = agentAuthor('author-dorkbot', '/dork/dorkbot', DORKBOT.id);
    rooms.createRoom(
      {
        id: 'team-room',
        kind: 'channel',
        slug: 'team',
        title: 'Team',
        topic: null,
        workspaceId: null,
        createdAt: '2026-08-01T00:00:00.000Z',
      },
      [ownerAuthorId, anaAuthorId, dorkbotAuthorId].map((authorId) => ({
        authorId,
        responseMode: 'engaged' as const,
        joinedAt: '2026-08-01T00:00:00.000Z',
      }))
    );
  });

  it('lists the rooms a person is in', async () => {
    const res = await request(app()).get(`/api/team/${ownerAuthorId}/rooms`);

    expect(res.status).toBe(200);
    expect(MemberRoomsResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.rooms).toEqual([
      { id: 'team-room', name: 'Team', slug: 'team', kind: 'channel', memberCount: 3 },
    ]);
  });

  it('lists the rooms an agent is in, addressed by its manifest id', async () => {
    const res = await request(app()).get(`/api/team/${ANA.id}/rooms`);

    expect(res.status).toBe(200);
    expect(res.body.rooms.map((room: { id: string }) => room.id)).toEqual(['team-room']);
  });

  it('lists the rooms the system agent is in', async () => {
    const res = await request(app()).get(`/api/team/${DORKBOT.id}/rooms`);

    expect(res.status).toBe(200);
    expect(res.body.rooms.map((room: { id: string }) => room.id)).toEqual(['team-room']);
  });

  it('answers 404 for an id this install has never heard of', async () => {
    const res = await request(app()).get('/api/team/nobody/rooms');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('MEMBER_NOT_FOUND');
  });

  it('answers an empty list for an agent that has not been in a room yet', async () => {
    // On the roster (the mesh has it), with no author row — the state every
    // newly registered agent is in. A 404 here would put an error on the
    // profile of a perfectly ordinary agent.
    const fresh: TeamAgentSource = { ...ANA, id: 'agent-new', name: 'new' };
    const res = await request(
      app({ meshCore: { listWithHealth: () => [ANA, DORKBOT, fresh] } })
    ).get('/api/team/agent-new/rooms');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rooms: [] });
  });

  it('still answers for authors when the mesh never started', async () => {
    // The degraded case: without the registry, an id with no author row can no
    // longer be told from an unknown one — but everybody who has ever been in a
    // room still resolves, which is everybody this page asks about.
    const res = await request(app({ meshCore: undefined })).get(`/api/team/${ANA.id}/rooms`);

    expect(res.status).toBe(200);
    expect(res.body.rooms).toHaveLength(1);
  });

  it('answers 500 when the room store cannot be read', async () => {
    const res = await request(
      app({
        rooms: {
          listRoomsForMember: () => {
            throw new Error('database is locked');
          },
          listMembersForRooms: () => [],
        },
      })
    ).get(`/api/team/${ownerAuthorId}/rooms`);

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('MEMBER_ROOMS_FAILED');
  });

  it('refuses an agent, which could otherwise enumerate the operator’s DMs', async () => {
    // The route takes ANY member's id, so an agent that could call it would read
    // the title of every DM the operator has — walking around the membership
    // scope `listRoomsForMember` exists to impose by asking about somebody else.
    const res = await request(app())
      .get(`/api/team/${ownerAuthorId}/rooms`)
      .set('x-dorkos-agent', 'some-agent-token');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PEOPLE_ONLY');
  });

  it('leaves an agent’s author id out of the id space it answers for', async () => {
    // The roster hands out manifest ULIDs for agents and author ids for people.
    // Accepting an agent's author id would be a third id space nothing produces.
    const res = await request(app()).get('/api/team/author-ana/rooms');

    expect(res.status).toBe(404);
  });
});
