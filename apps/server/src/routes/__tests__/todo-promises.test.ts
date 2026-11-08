/**
 * The to-do routes (spec `heartbeats` §12): anyone lists, a person adds
 * one for an agent, and only the promising agent or a person changes one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { createAgentTodoPromisesRoutes, createTodoPromisesRoutes } from '../todo-promises.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { TodoPromiseService, TodoPromiseStore } from '../../services/todos/index.js';
import { AGENT_IDENTITY_HEADER } from '../../middleware/agent-identity.js';
import { personProof } from '../../services/todos/caller.js';
import { todos, eq, type Db } from '@dorkos/db';

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// The `/api` chain reads config (login, the host allowlist); nothing is set.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

const AGENTS: Record<string, string> = { '/agents/ana': 'agent-ana', '/agents/bo': 'agent-bo' };

describe('to-do routes', () => {
  let service: TodoPromiseService;
  /** Whether the caller counts as the install's owner; flipped per test. */
  let owner: boolean;
  let db: Db;

  /** A row's stored authority columns. */
  function power(id: string) {
    return db
      .select({ authority: todos.authority, marks: todos.authorityMarks })
      .from(todos)
      .where(eq(todos.id, id))
      .get();
  }

  beforeEach(() => {
    owner = true;
    db = createTestDb();
    service = new TodoPromiseService({ store: new TodoPromiseStore(db) });
    const deps = {
      isOwner: () => owner,
      // The real proof: these requests carry no session cookie, as a local program's would not.
      personProven: personProof,
      service,
      agentExists: (id: string) => Object.values(AGENTS).includes(id),
    };
    const app = honoGroupListener(
      [
        { path: '/api/todo-promises', routes: createTodoPromisesRoutes(deps) },
        { path: '/api/agents/:id/todo-promises', routes: createAgentTodoPromisesRoutes(deps) },
      ],
      {
        // Stand in for the agent-identity step: the header names a home folder,
        // and an unknown one resolves to nothing (a token that did not verify).
        before: (c, next) => {
          const home = c.req.header(AGENT_IDENTITY_HEADER);
          if (home && AGENTS[home]) {
            c.set('agentIdentity', { agentPath: home, displayName: home, createdAt: '' });
          }
          return next();
        },
      }
    );
    fixtureTarget.mount(app);
  });

  afterEach(() => service.stop());

  it("refuses an agent's own token on PATCH, so a Blocked To-dos area can't be skipped (DOR-3936, Security M1)", async () => {
    // This route runs no permission check: an agent changes its promises with
    // todo_promise_update, which the gate decides. Its own token, here, changes nothing.
    const made = service.create('agent-ana', { what: 'Ship it' });
    const before = service.get(made.id);
    const res = await request(fixtureServer)
      .patch(`/api/todo-promises/${made.id}`)
      .set(AGENT_IDENTITY_HEADER, '/agents/ana')
      .send({ state: 'kept' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_A_PERSON');
    expect(service.get(made.id)).toEqual(before);
  });

  describe('person authority needs proof (DOR-3088, Security Must for PR 2)', () => {
    it('never mints person authority from the open gate: login off, no agent headers, no cookie', async () => {
      // `isOwner` passes, as it does for any program on this computer with login off.
      const res = await request(fixtureServer)
        .post('/api/agents/agent-ana/todo-promises')
        .send({ what: 'Delete the staging bucket' });
      expect(res.status).toBe(201);
      expect(power(res.body.id)).toEqual({
        authority: 'runtime-default',
        marks: '{"outsider":true}',
      });
    });

    it('lowers a proven person to-do to the stranger bound when an unproven request edits it', async () => {
      const made = service.create(
        'agent-ana',
        { what: 'Ship it' },
        { kind: 'person', proven: true }
      );
      expect(power(made.id)).toEqual({ authority: 'person', marks: '{}' });

      const res = await request(fixtureServer)
        .patch(`/api/todo-promises/${made.id}`)
        .send({ state: 'open', dueAt: '2099-10-12T09:00:00Z' });
      expect(res.status).toBe(200);
      expect(power(made.id)).toEqual({ authority: 'runtime-default', marks: '{"outsider":true}' });
    });
  });

  it('lets a person add a promise for an agent, and anyone list it', async () => {
    const created = await request(fixtureServer)
      .post('/api/agents/agent-ana/todo-promises')
      .send({ what: 'Reply to Acme', to: 'external:Acme', dueAt: '2099-10-11T09:00:00Z' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ agentId: 'agent-ana', state: 'open', overdue: false });

    const listed = await request(fixtureServer)
      .get('/api/todo-promises?agentId=agent-ana')
      .set(AGENT_IDENTITY_HEADER, '/agents/bo');
    expect(listed.status).toBe(200);
    expect(listed.body.todoPromises).toHaveLength(1);
    expect(listed.body.todoPromises[0].what).toBe('Reply to Acme');
  });

  it('refuses an agent adding one through the person route', async () => {
    const res = await request(fixtureServer)
      .post('/api/agents/agent-ana/todo-promises')
      .set(AGENT_IDENTITY_HEADER, '/agents/ana')
      .send({ what: 'Reply' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_A_PERSON');
    expect(service.list()).toEqual([]);
  });

  it('answers 404 for an agent not on the team, and 400 for a bad body', async () => {
    const unknown = await request(fixtureServer)
      .post('/api/agents/nobody/todo-promises')
      .send({ what: 'Reply' });
    expect(unknown.status).toBe(404);
    const empty = await request(fixtureServer).post('/api/agents/agent-ana/todo-promises').send({});
    expect(empty.status).toBe(400);
  });

  it('lets a person change one, and refuses every agent caller', async () => {
    const made = service.create('agent-ana', { what: 'Ship it' });

    for (const header of ['/agents/ana', '/agents/bo', 'not-a-token']) {
      const res = await request(fixtureServer)
        .patch(`/api/todo-promises/${made.id}`)
        .set(AGENT_IDENTITY_HEADER, header)
        .send({ state: 'open', dueAt: '2099-10-12T09:00:00Z' });
      expect(res.status, header).toBe(403);
      expect(res.body.code, header).toBe('NOT_A_PERSON');
    }
    expect(service.get(made.id)!.state).toBe('open');
    expect(service.get(made.id)!.dueAt).toBeNull();

    const person = await request(fixtureServer)
      .patch(`/api/todo-promises/${made.id}`)
      .send({ state: 'kept' });
    expect(person.status).toBe(200);
    expect(person.body.state).toBe('kept');

    const again = await request(fixtureServer)
      .patch(`/api/todo-promises/${made.id}`)
      .send({ state: 'kept' });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('NOTHING_TO_CHANGE');

    const reopened = await request(fixtureServer)
      .patch(`/api/todo-promises/${made.id}`)
      .send({ state: 'open' });
    expect(reopened.status).toBe(200);
    expect(reopened.body.state).toBe('open');
  });

  it('refuses a person who is not the owner, on add and on change', async () => {
    const made = service.create('agent-ana', { what: 'Ship it' });
    owner = false;
    const add = await request(fixtureServer)
      .post('/api/agents/agent-ana/todo-promises')
      .send({ what: 'Reply' });
    expect(add.status).toBe(403);
    expect(add.body.code).toBe('NOT_YOURS');
    const change = await request(fixtureServer)
      .patch(`/api/todo-promises/${made.id}`)
      .send({ state: 'kept' });
    expect(change.status).toBe(403);
    expect(change.body.code).toBe('NOT_YOURS');
    expect(service.get(made.id)!.state).toBe('open');
    expect(service.list({})).toHaveLength(1);
  });

  it('answers 409 CONFLICT when `from` no longer matches', async () => {
    const made = service.create('agent-ana', { what: 'Ship it' });
    const res = await request(fixtureServer)
      .patch(`/api/todo-promises/${made.id}`)
      .send({ state: 'open', from: 'kept' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });

  it('shows the source chat to the owner only', async () => {
    service.create('agent-ana', { what: 'Ship it', sourceSessionId: 'chat-1' });
    const mine = await request(fixtureServer).get('/api/todo-promises');
    expect(mine.body.todoPromises[0].sourceSessionId).toBe('chat-1');
    owner = false;
    const theirs = await request(fixtureServer).get('/api/todo-promises');
    expect(theirs.body.todoPromises[0].sourceSessionId).toBeNull();
    expect(theirs.body.todoPromises[0].what).toBe('Ship it');
  });

  it('refuses a past due date with PAST_DUE', async () => {
    const res = await request(fixtureServer)
      .post('/api/agents/agent-ana/todo-promises')
      .send({ what: 'Reply', dueAt: '2020-01-01T00:00:00Z' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PAST_DUE');
  });

  it('answers 404 for an unknown to-do', async () => {
    const res = await request(fixtureServer)
      .patch('/api/todo-promises/nope')
      .send({ state: 'kept' });
    expect(res.status).toBe(404);
  });
});
