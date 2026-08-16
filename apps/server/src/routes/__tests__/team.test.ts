/**
 * `GET /api/team` over HTTP — the envelope, the status codes, and the two
 * things that must never be true of this route: that it writes, and that a
 * failed source turns into a failed request (ADR 260806-222535).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';
import { TeamRosterResponseSchema } from '@dorkos/shared/team-schemas';
import { AuthorRegistry } from '../../services/rooms/author-registry.js';
import { createTeamRouter, type TeamMeshReader, type TeamRouterDeps } from '../team.js';
import type { TeamAgentSource } from '../../services/identity/aggregate-team.js';

const OWNER_USER_ID = 'user-1';

/** Where Ana lives — the path the mesh strips and this route joins back on. */
const ANA_PATH = '/Users/dorian/agents/ana';

const ANA: TeamAgentSource = {
  id: 'agent-ana',
  name: 'ana',
  displayName: 'Ana',
  runtime: 'claude-code',
  // As the PUBLIC mesh listing hands it over: `namespace` and `projectPath`
  // stripped by `toManifest()`. The route puts the path back from
  // `listWithPaths()`; the namespace stays gone.
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
  let ownerAuthorId: string;

  function app(overrides: Partial<TeamRouterDeps> = {}) {
    const mesh: TeamMeshReader = {
      listWithHealth: () => [ANA, DORKBOT],
      listWithPaths: () => [{ id: ANA.id, projectPath: ANA_PATH }],
    };
    const server = express();
    server.use(
      '/api/team',
      createTeamRouter({
        authors: registry,
        meshCore: mesh,
        activeClaims: () => [],
        listRooms: () => [],
        sessionActivity: () => Promise.resolve({}),
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
          listWithPaths: () => [],
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

  describe('what the profile reads (spec `profile-unification` §3.1)', () => {
    /**
     * Ana's author row, stamped with the mesh occupancy the roster joins claims
     * on. Written through the real registries, because the join under test is
     * `mintedForManifestId` → author id → claim, and a hand-made id would prove
     * only that a map lookup works.
     */
    function mintAnaAuthor(): string {
      const now = new Date().toISOString();
      db.insert(agents)
        .values({
          id: ANA.id,
          name: 'ana',
          displayName: 'Ana',
          runtime: 'claude-code',
          projectPath: ANA_PATH,
          registeredAt: now,
          updatedAt: now,
        })
        .run();
      return registry.resolveAgent(ANA_PATH, 'Ana').id;
    }

    it('puts the project path back on a local agent, and leaves the namespace off', async () => {
      const res = await request(app()).get('/api/team');
      const ana = res.body.members.find((m: { id: string }) => m.id === ANA.id);

      // Joined from `listWithPaths()`, which is the only reader here entitled to
      // it: the public listing this route also calls has it stripped.
      expect(ana.agent.projectPath).toBe(ANA_PATH);
      expect(ana.agent.namespace).toBeUndefined();
      // An agent the paths listing does not know stays pathless rather than
      // borrowing one.
      const dorkbot = res.body.members.find((m: { id: string }) => m.id === DORKBOT.id);
      expect(dorkbot.agent.projectPath).toBeUndefined();
    });

    it('reports the room an agent is mid-turn in, by name', async () => {
      const authorId = mintAnaAuthor();
      const res = await request(
        app({
          activeClaims: () => [
            { roomId: 'room-1', authorId, claimedAt: '2026-08-16T10:00:00.000Z' },
          ],
          listRooms: () => [{ id: 'room-1', name: 'team' }],
        })
      ).get('/api/team');

      expect(TeamRosterResponseSchema.safeParse(res.body).success).toBe(true);
      expect(res.body.members.find((m: { id: string }) => m.id === ANA.id).agent.activity).toEqual({
        working: { roomId: 'room-1', roomName: 'team', since: '2026-08-16T10:00:00.000Z' },
        lastActiveAt: null,
      });
    });

    it('dates an agent from its newest session, keyed on the path it just recovered', async () => {
      const res = await request(
        app({ sessionActivity: () => Promise.resolve({ [ANA_PATH]: '2026-08-15T09:00:00.000Z' }) })
      ).get('/api/team');

      expect(res.body.members.find((m: { id: string }) => m.id === ANA.id).agent.activity).toEqual({
        working: null,
        lastActiveAt: '2026-08-15T09:00:00.000Z',
      });
    });

    it('answers 200 with a warning when a claim or session read throws', async () => {
      const res = await request(
        app({
          activeClaims: () => {
            throw new Error('dispatcher unavailable');
          },
          sessionActivity: () => Promise.reject(new Error('runtime unavailable')),
        })
      ).get('/api/team');

      expect(res.status).toBe(200);
      // Every row still there, and every agent honestly says it knows nothing
      // about what it is doing — never a failed roster.
      expect(res.body.members).toHaveLength(3);
      expect(res.body.members.find((m: { id: string }) => m.id === ANA.id).agent.activity).toEqual({
        working: null,
        lastActiveAt: null,
      });
      expect(res.body.warnings.map((w: { source: string }) => w.source)).toEqual([
        'claims',
        'sessions',
      ]);
    });

    it('stamps the operator as here now, and nobody else', async () => {
      registry.resolveExternal({
        platformType: 'telegram',
        instanceId: 'inst-1',
        platformUserId: 'tg-9',
        displayName: 'Priya',
      });
      const before = Date.now();
      const res = await request(app()).get('/api/team');

      const self = res.body.members.find((m: { isSelf: boolean }) => m.isSelf);
      expect(Date.parse(self.person.lastSeenAt)).toBeGreaterThanOrEqual(before - 1000);
      const priya = res.body.members.find(
        (m: { displayName: string }) => m.displayName === 'Priya'
      );
      expect(priya.person.lastSeenAt).toBeNull();
    });
  });

  it('has no write path', async () => {
    const server = app();
    expect((await request(server).post('/api/team').send({ id: 'x' })).status).toBe(404);
    expect((await request(server).patch('/api/team/x').send({})).status).toBe(404);
    expect((await request(server).delete('/api/team/x')).status).toBe(404);
  });
});
