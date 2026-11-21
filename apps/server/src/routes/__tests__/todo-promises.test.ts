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
import { TodoConfirm } from '../../services/todos/notice/todo-confirm.js';
import { AGENT_IDENTITY_HEADER } from '../../middleware/agent-identity.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
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

/**
 * Test-only headers, read after the `/api` chain: mark the request as arriving over Wi-Fi (as
 * the Wi-Fi listener does), or as forwarded from another device. Both reach the route past the
 * gate, so the route's own check is what's tested.
 */
const VIA_WIFI = 'x-test-via-wifi';
const FORWARDED_AFTER_GATE = 'x-test-forwarded-for';

describe('to-do routes', () => {
  let service: TodoPromiseService;
  /** Whether the caller counts as the install's owner; flipped per test. */
  let owner: boolean;
  /** Whether the install has an owner account; flipped per test. */
  let ownerAccount: boolean;
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
    ownerAccount = true;
    db = createTestDb();
    service = new TodoPromiseService({ store: new TodoPromiseStore(db) });
    const deps = {
      isOwner: () => owner,
      // The real proof: these requests carry no session cookie, as a local program's would not.
      personProven: personProof,
      ownerExists: () => ownerAccount,
      confirm: new TodoConfirm({
        store: new TodoPromiseStore(db),
        reopen: (actor, id, note) =>
          service.update(actor, id, { state: 'open', note, from: 'kept' }),
        wakeNow: (id) => service.wakeNow(id),
      }),
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
          if (c.req.header(VIA_WIFI)) markIngress(c.env.incoming, 'wifi');
          const forwarded = c.req.header(FORWARDED_AFTER_GATE);
          if (forwarded) c.env.incoming.headers['x-forwarded-for'] = forwarded;
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
    it('never mints person authority from the open gate once an owner account exists: login off, no agent headers, no cookie', async () => {
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

  describe('on an install with no owner account (DOR-3832)', () => {
    beforeEach(() => {
      ownerAccount = false;
    });

    it('saves a promise a person at this computer adds as theirs, not at the stranger bound', async () => {
      const res = await request(fixtureServer)
        .post('/api/agents/agent-ana/todo-promises')
        .send({ what: 'Send Acme the quote' });
      expect(res.status).toBe(201);
      expect(power(res.body.id)).toEqual({ authority: 'person', marks: '{}' });
    });

    it('lets the person drop a promise they added with one click, no note, and keeps it theirs', async () => {
      const added = await request(fixtureServer)
        .post('/api/agents/agent-ana/todo-promises')
        .send({ what: 'Send Acme the quote' });
      const res = await request(fixtureServer)
        .patch(`/api/todo-promises/${added.body.id}`)
        .send({ state: 'dropped' });
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('dropped');
      expect(power(added.body.id)).toEqual({ authority: 'person', marks: '{}' });
    });

    it('never counts a Wi-Fi request as the person: its add stays the stranger bound, its drop needs a note', async () => {
      const given = service.create(
        'agent-ana',
        { what: 'Ship it' },
        { kind: 'person', proven: true }
      );
      const add = await request(fixtureServer)
        .post('/api/agents/agent-ana/todo-promises')
        .set(VIA_WIFI, '1')
        .send({ what: 'Delete the staging bucket' });
      expect(add.status).toBe(201);
      expect(power(add.body.id)).toEqual({
        authority: 'runtime-default',
        marks: '{"outsider":true}',
      });
      const drop = await request(fixtureServer)
        .patch(`/api/todo-promises/${given.id}`)
        .set(VIA_WIFI, '1')
        .send({ state: 'dropped' });
      expect(drop.status).toBe(400);
      expect(drop.body.code).toBe('NOTHING_TO_CHANGE');
      expect(service.get(given.id)!.state).toBe('open');
      expect(power(given.id)).toEqual({ authority: 'person', marks: '{}' });
    });

    it('has the gate ask a forwarded request from another device for a credential first', async () => {
      const given = service.create(
        'agent-ana',
        { what: 'Ship it' },
        { kind: 'person', proven: true }
      );
      const add = await request(fixtureServer)
        .post('/api/agents/agent-ana/todo-promises')
        .set('x-forwarded-for', '203.0.113.7')
        .send({ what: 'Delete the staging bucket' });
      expect(add.status).toBe(401);
      const drop = await request(fixtureServer)
        .patch(`/api/todo-promises/${given.id}`)
        .set('x-forwarded-for', '203.0.113.7')
        .send({ state: 'dropped' });
      expect(drop.status).toBe(401);
      expect(service.list()).toHaveLength(1);
      expect(service.get(given.id)!.state).toBe('open');
    });

    it('never counts a forwarded request that got past the gate as the person', async () => {
      const given = service.create(
        'agent-ana',
        { what: 'Ship it' },
        { kind: 'person', proven: true }
      );
      const add = await request(fixtureServer)
        .post('/api/agents/agent-ana/todo-promises')
        .set(FORWARDED_AFTER_GATE, '203.0.113.7')
        .send({ what: 'Delete the staging bucket' });
      expect(add.status).toBe(201);
      expect(power(add.body.id)).toEqual({
        authority: 'runtime-default',
        marks: '{"outsider":true}',
      });
      const drop = await request(fixtureServer)
        .patch(`/api/todo-promises/${given.id}`)
        .set(FORWARDED_AFTER_GATE, '203.0.113.7')
        .send({ state: 'dropped' });
      expect(drop.status).toBe(400);
      expect(drop.body.code).toBe('NOTHING_TO_CHANGE');
      expect(service.get(given.id)!.state).toBe('open');
    });

    it('never counts a program sending a credential as the person, even at this computer', async () => {
      const add = await request(fixtureServer)
        .post('/api/agents/agent-ana/todo-promises')
        .set('authorization', 'Bearer made-up-token')
        .send({ what: 'Delete the staging bucket' });
      expect(add.status).toBe(201);
      expect(power(add.body.id)).toEqual({
        authority: 'runtime-default',
        marks: '{"outsider":true}',
      });
    });

    it('lets the /api host guard refuse a request naming another host on the network', async () => {
      const add = await request(fixtureServer)
        .post('/api/agents/agent-ana/todo-promises')
        .set('host', '192.168.1.20:4243')
        .send({ what: 'Delete the staging bucket' });
      expect(add.status).toBe(403);
      expect(service.list()).toEqual([]);
    });

    it('still refuses every agent caller, verified or not, on add and on change', async () => {
      const made = service.create(
        'agent-ana',
        { what: 'Ship it' },
        { kind: 'person', proven: true }
      );
      for (const header of ['/agents/ana', '/agents/bo', 'not-a-token']) {
        const add = await request(fixtureServer)
          .post('/api/agents/agent-ana/todo-promises')
          .set(AGENT_IDENTITY_HEADER, header)
          .send({ what: 'Reply' });
        expect(add.status, header).toBe(403);
        expect(add.body.code, header).toBe('NOT_A_PERSON');
        const drop = await request(fixtureServer)
          .patch(`/api/todo-promises/${made.id}`)
          .set(AGENT_IDENTITY_HEADER, header)
          .send({ state: 'dropped' });
        expect(drop.status, header).toBe(403);
        expect(drop.body.code, header).toBe('NOT_A_PERSON');
      }
      expect(service.list()).toHaveLength(1);
      expect(service.get(made.id)!.state).toBe('open');
    });
  });

  describe('once an owner account exists, a request that proves nobody is unchanged', () => {
    it('still stores its add at the stranger bound and needs a note to drop one somebody gave', async () => {
      const added = await request(fixtureServer)
        .post('/api/agents/agent-ana/todo-promises')
        .send({ what: 'Send Acme the quote' });
      expect(power(added.body.id)).toEqual({
        authority: 'runtime-default',
        marks: '{"outsider":true}',
      });
      const given = service.create(
        'agent-ana',
        { what: 'Ship it' },
        { kind: 'person', proven: true }
      );
      const res = await request(fixtureServer)
        .patch(`/api/todo-promises/${given.id}`)
        .send({ state: 'dropped' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NOTHING_TO_CHANGE');
      expect(service.get(given.id)!.state).toBe('open');
      expect(power(given.id)).toEqual({ authority: 'person', marks: '{}' });
    });

    it('refuses a caller that is not the owner (login on, no owner credential)', async () => {
      const given = service.create(
        'agent-ana',
        { what: 'Ship it' },
        { kind: 'person', proven: true }
      );
      owner = false;
      const add = await request(fixtureServer)
        .post('/api/agents/agent-ana/todo-promises')
        .send({ what: 'Reply' });
      expect(add.status).toBe(403);
      const drop = await request(fixtureServer)
        .patch(`/api/todo-promises/${given.id}`)
        .send({ state: 'dropped' });
      expect(drop.status).toBe(403);
      expect(drop.body.code).toBe('NOT_YOURS');
      expect(service.list()).toHaveLength(1);
      expect(service.get(given.id)!.state).toBe('open');
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

  it("takes a person's Yes or Not yet on a kept promise, and refuses an agent (DOR-3034)", async () => {
    const confirm = new TodoConfirm({
      store: new TodoPromiseStore(db),
      reopen: (actor, id, note) => service.update(actor, id, { state: 'open', note, from: 'kept' }),
      wakeNow: (id) => service.wakeNow(id),
    });
    const yes = service.create('agent-ana', { what: 'Ship it', to: 'owner' });
    service.update({ kind: 'agent', agentId: 'agent-ana' }, yes.id, { state: 'kept' });
    expect(confirm.ask(yes.id)).toBe(true);

    const agent = await request(fixtureServer)
      .post(`/api/todo-promises/${yes.id}/confirm`)
      .set(AGENT_IDENTITY_HEADER, '/agents/ana')
      .send({ answer: 'yes' });
    expect(agent.status).toBe(403);

    const confirmed = await request(fixtureServer)
      .post(`/api/todo-promises/${yes.id}/confirm`)
      .send({ answer: 'yes' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.confirmState).toBe('confirmed');
    const twice = await request(fixtureServer)
      .post(`/api/todo-promises/${yes.id}/confirm`)
      .send({ answer: 'not-yet' });
    expect(twice.body.code).toBe('NOTHING_TO_CHANGE');

    const notYet = service.create('agent-ana', { what: 'Send the deck', to: 'owner' });
    service.update({ kind: 'agent', agentId: 'agent-ana' }, notYet.id, { state: 'kept' });
    confirm.ask(notYet.id);
    const reopened = await request(fixtureServer)
      .post(`/api/todo-promises/${notYet.id}/confirm`)
      .send({ answer: 'not-yet' });
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ state: 'open', confirmState: 'not-yet' });
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
