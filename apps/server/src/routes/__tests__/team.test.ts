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
import { TeamRosterResponseSchema } from '@dorkos/shared/team-schemas';
import { AuthorRegistry } from '../../services/rooms/author-registry.js';
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
  let ownerAuthorId: string;

  function app(overrides: Partial<TeamRouterDeps> = {}) {
    const mesh: TeamMeshReader = { listWithHealth: () => [ANA, DORKBOT] };
    const server = express();
    server.use(
      '/api/team',
      createTeamRouter({
        authors: registry,
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

  it('falls back to the stored name when this install has no account', async () => {
    const res = await request(app({ ownerAccount: () => null })).get('/api/team');
    // With no account, `isOwner` reads the `'local'` sentinel — which
    // `bindOwner` has already taken over — so nobody on this roster is the
    // operator, and the row keeps the name it was minted under.
    expect(res.body.members[0]?.displayName).toBe('You');
    expect(res.body.members[0]?.isSelf).toBe(false);
  });

  it('has no write path', async () => {
    const server = app();
    expect((await request(server).post('/api/team').send({ id: 'x' })).status).toBe(404);
    expect((await request(server).patch('/api/team/x').send({})).status).toBe(404);
    expect((await request(server).delete('/api/team/x')).status).toBe(404);
  });
});
