/**
 * The commitment routes (spec `heartbeats` §12): anyone lists, a person adds
 * one for an agent, and only the promising agent or a person changes one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { createAgentCommitmentsRouter, createCommitmentsRouter } from '../commitments.js';
import { CommitmentService, CommitmentStore } from '../../services/commitments/index.js';
import { AGENT_IDENTITY_HEADER } from '../../middleware/agent-identity.js';

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

const AGENTS: Record<string, string> = { '/agents/ana': 'agent-ana', '/agents/bo': 'agent-bo' };

describe('commitment routes', () => {
  let service: CommitmentService;
  /** Whether the caller counts as the install's owner; flipped per test. */
  let owner: boolean;

  beforeEach(() => {
    owner = true;
    service = new CommitmentService({ store: new CommitmentStore(createTestDb()) });
    const deps = {
      isOwner: () => owner,
      service,
      agentExists: (id: string) => Object.values(AGENTS).includes(id),
      agentIdForPath: (agentPath: string) => AGENTS[agentPath],
    };
    const app = express();
    app.use(express.json());
    // Stand in for the agent-identity middleware: the header names a home
    // folder, and an unknown one resolves to nothing (a token that did not verify).
    app.use((req, res, next) => {
      const home = req.headers[AGENT_IDENTITY_HEADER];
      if (typeof home === 'string' && AGENTS[home]) {
        res.locals.agentIdentity = { agentPath: home, displayName: home, createdAt: '' };
      }
      next();
    });
    app.use('/api/commitments', createCommitmentsRouter(deps));
    app.use('/api/agents/:id/commitments', createAgentCommitmentsRouter(deps));
    fixtureTarget.mount(app);
  });

  afterEach(() => service.stop());

  it('lets a person add a promise for an agent, and anyone list it', async () => {
    const created = await request(fixtureServer)
      .post('/api/agents/agent-ana/commitments')
      .send({ what: 'Reply to Acme', to: 'external:Acme', dueAt: '2099-10-11T09:00:00Z' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ agentId: 'agent-ana', state: 'open', overdue: false });

    const listed = await request(fixtureServer)
      .get('/api/commitments?agentId=agent-ana')
      .set(AGENT_IDENTITY_HEADER, '/agents/bo');
    expect(listed.status).toBe(200);
    expect(listed.body.commitments).toHaveLength(1);
    expect(listed.body.commitments[0].what).toBe('Reply to Acme');
  });

  it('refuses an agent adding one through the person route', async () => {
    const res = await request(fixtureServer)
      .post('/api/agents/agent-ana/commitments')
      .set(AGENT_IDENTITY_HEADER, '/agents/ana')
      .send({ what: 'Reply' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_A_PERSON');
    expect(service.list()).toEqual([]);
  });

  it('answers 404 for an agent not on the team, and 400 for a bad body', async () => {
    const unknown = await request(fixtureServer)
      .post('/api/agents/nobody/commitments')
      .send({ what: 'Reply' });
    expect(unknown.status).toBe(404);
    const empty = await request(fixtureServer).post('/api/agents/agent-ana/commitments').send({});
    expect(empty.status).toBe(400);
  });

  it('lets the promising agent and a person change one, and refuses another agent', async () => {
    const made = service.create('agent-ana', { what: 'Ship it' });

    const other = await request(fixtureServer)
      .patch(`/api/commitments/${made.id}`)
      .set(AGENT_IDENTITY_HEADER, '/agents/bo')
      .send({ state: 'kept' });
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('NOT_YOURS');

    const unverified = await request(fixtureServer)
      .patch(`/api/commitments/${made.id}`)
      .set(AGENT_IDENTITY_HEADER, 'not-a-token')
      .send({ state: 'kept' });
    expect(unverified.status).toBe(403);
    expect(unverified.body.code).toBe('NO_AGENT');
    expect(service.get(made.id)!.state).toBe('open');

    const own = await request(fixtureServer)
      .patch(`/api/commitments/${made.id}`)
      .set(AGENT_IDENTITY_HEADER, '/agents/ana')
      .send({ state: 'open', dueAt: '2099-10-12T09:00:00Z' });
    expect(own.status).toBe(200);
    expect(own.body.dueAt).toBe('2099-10-12T09:00:00.000Z');

    const person = await request(fixtureServer)
      .patch(`/api/commitments/${made.id}`)
      .send({ state: 'kept' });
    expect(person.status).toBe(200);
    expect(person.body.state).toBe('kept');

    const again = await request(fixtureServer)
      .patch(`/api/commitments/${made.id}`)
      .send({ state: 'kept' });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('NOTHING_TO_CHANGE');

    const reopened = await request(fixtureServer)
      .patch(`/api/commitments/${made.id}`)
      .send({ state: 'open' });
    expect(reopened.status).toBe(200);
    expect(reopened.body.state).toBe('open');
  });

  it('refuses a person who is not the owner, on add and on change', async () => {
    const made = service.create('agent-ana', { what: 'Ship it' });
    owner = false;
    const add = await request(fixtureServer)
      .post('/api/agents/agent-ana/commitments')
      .send({ what: 'Reply' });
    expect(add.status).toBe(403);
    expect(add.body.code).toBe('NOT_YOURS');
    const change = await request(fixtureServer)
      .patch(`/api/commitments/${made.id}`)
      .send({ state: 'kept' });
    expect(change.status).toBe(403);
    expect(change.body.code).toBe('NOT_YOURS');
    expect(service.get(made.id)!.state).toBe('open');
    expect(service.list({})).toHaveLength(1);
  });

  it('answers 409 CONFLICT when `from` no longer matches', async () => {
    const made = service.create('agent-ana', { what: 'Ship it' });
    const res = await request(fixtureServer)
      .patch(`/api/commitments/${made.id}`)
      .send({ state: 'open', from: 'kept' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });

  it('shows the source chat to the owner only', async () => {
    service.create('agent-ana', { what: 'Ship it', sourceSessionId: 'chat-1' });
    const mine = await request(fixtureServer).get('/api/commitments');
    expect(mine.body.commitments[0].sourceSessionId).toBe('chat-1');
    owner = false;
    const theirs = await request(fixtureServer).get('/api/commitments');
    expect(theirs.body.commitments[0].sourceSessionId).toBeNull();
    expect(theirs.body.commitments[0].what).toBe('Ship it');
  });

  it('refuses a past due date with PAST_DUE', async () => {
    const res = await request(fixtureServer)
      .post('/api/agents/agent-ana/commitments')
      .send({ what: 'Reply', dueAt: '2020-01-01T00:00:00Z' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PAST_DUE');
  });

  it('answers 404 for an unknown commitment', async () => {
    const res = await request(fixtureServer).patch('/api/commitments/nope').send({ state: 'kept' });
    expect(res.status).toBe(404);
  });
});
