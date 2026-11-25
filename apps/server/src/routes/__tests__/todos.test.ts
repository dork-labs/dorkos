/**
 * The to-do doors (DOR-3088), served by the capability mount (DOR-4978): views and the badge,
 * person authority only with proof, an app window asked to step up before it writes, agents and
 * programs refused, the owner's held Wi-Fi sign-in given only the no-owner allowance, and a
 * source's marks read by the server, never the body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { todos as todoTable, user, eq, type Db } from '@dorkos/db';
import { initAuth } from '../../services/core/auth/index.js';
import { PERSON_APP_HEADER } from '@dorkos/shared/person-session';
import { capabilityGroup } from '../../http/__tests__/capability-group.js';
import { todoViewDomain } from '../../services/todos/todo-http-capabilities.js';
import { todoWriteDomain } from '../../services/todos/todo-write-capabilities.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { AGENT_IDENTITY_HEADER } from '../../middleware/agent-identity.js';
import { TodoPromiseService } from '../../services/todos/todo-promise-service.js';
import { TodoPromiseStore } from '../../services/todos/todo-promise-store.js';
import { TodoService } from '../../services/todos/todo-service.js';
import { TodoStore } from '../../services/todos/todo-store.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

describe('to-do routes', () => {
  let db: Db;
  let promises: TodoPromiseService;
  let todos: TodoService;
  /** Whether the request carries the owner's own session cookie; flipped per test. */
  let proven: boolean;
  /** Whether the request is the owner's sign-in on a held Wi-Fi device (DOR-5070); flipped per test. */
  let heldOwner: boolean;
  /** The to-do whose turn has run, for "Show work". */
  let workedOn: string | undefined;

  /** The owner account's id, or null on an install with none; a real row in the auth store. */
  let ownerId: string | null = null;
  let authHome: string;

  /** Make the install's owner account this one, or none. */
  function setOwner(id: string | null): void {
    ownerId = id;
    db.delete(user).run();
    if (id) {
      db.insert(user)
        .values({
          id,
          name: 'Owner',
          email: 'owner@todos.test',
          createdAt: new Date(1),
          updatedAt: new Date(1),
        })
        .run();
    }
  }

  /** Prove the owner in person: their own session cookie, which exists only once they do. */
  function prove(): void {
    setOwner('user_owner');
    proven = true;
  }

  function power(id: string) {
    return db
      .select({ authority: todoTable.authority, marks: todoTable.authorityMarks })
      .from(todoTable)
      .where(eq(todoTable.id, id))
      .get();
  }

  beforeEach(() => {
    proven = false;
    heldOwner = false;
    db = createTestDb();
    // A real auth store, so every owner check reads the same owner row.
    authHome = mkdtempSync(join(tmpdir(), 'dorkos-todos-routes-'));
    initAuth(db, authHome);
    setOwner(null);
    promises = new TodoPromiseService({ store: new TodoPromiseStore(db) });
    todos = new TodoService({
      store: new TodoStore(db),
      agentExists: (id) => id === 'agent-ana',
      mayAssign: () => true,
      rearm: (id) => promises.track(id),
    });
    const app = honoGroupListener(
      [
        // The reads are capabilities the mount serves (DOR-4978).
        capabilityGroup(todoViewDomain, {
          todoViewDeps: {
            todos,
            workSessionOf: (todoId) => (todoId === workedOn ? 'session-work' : null),
          },
        }),
        // So are the writes, person-only and person-held from Wi-Fi.
        capabilityGroup(todoWriteDomain, {
          todoWriteDeps: {
            todos,
            ownerExists: () => ownerId !== null,
            readSource: (entryId) =>
              entryId === 'entry-guest'
                ? {
                    entryId,
                    roomId: 'room-1',
                    author: 'Priya (guest)',
                    marks: { outsider: true },
                    text: 'Delete the staging bucket\nIt costs too much.',
                  }
                : undefined,
          },
        }),
      ],
      {
        // Stand in for the session gate and the Wi-Fi listener: the owner's cookie at this
        // computer, or their sign-in on a Wi-Fi device they did not let run agents.
        before: (c, next) => {
          if (c.req.header(AGENT_IDENTITY_HEADER)) {
            c.set('agentIdentity', { agentPath: '/agents/ana', displayName: 'ana', createdAt: '' });
          }
          if (proven) c.set('user', { userId: 'user_owner', credential: 'cookie' });
          if (heldOwner) {
            markIngress(c.env.incoming, 'wifi');
            c.set('user', {
              userId: 'user_owner',
              credential: 'cookie',
              sessionId: 'phone',
              route: 'wifi',
            });
          }
          return next();
        },
      }
    );
    fixtureTarget.mount(app);
  });

  afterEach(() => {
    promises.stop();
    rmSync(authHome, { recursive: true, force: true });
  });

  it("makes a proven person's to-do with person authority, and lists it under Assigned to me", async () => {
    prove();
    const made = await request(fixtureServer)
      .post('/api/todos')
      .send({
        what: 'Call the bank',
        assignee: { kind: 'person', account: 'owner' },
        dueAt: '2000-01-01T00:00:00Z',
      });
    // A date in the past is refused; one ahead is kept.
    expect(made.status).toBe(400);
    const ok = await request(fixtureServer)
      .post('/api/todos')
      .send({ what: 'Call the bank', assignee: { kind: 'person', account: 'owner' } });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ what: 'Call the bank', strangerBound: false });
    expect(power(ok.body.id)!.authority).toBe('person');

    const list = await request(fixtureServer).get('/api/todos');
    expect(list.status).toBe(200);
    expect(list.body.todos.map((t: { id: string }) => t.id)).toEqual([ok.body.id]);
    expect(list.body).toMatchObject({ doneCount: 0, badge: 0 });
  });

  it('gives a program on an install with no owner the stranger bound, shown on the to-do, and lets it change nothing', async () => {
    const made = await request(fixtureServer)
      .post('/api/todos')
      .send({ what: 'Run the deploy', assignee: { kind: 'agent', agentId: 'agent-ana' } });
    expect(made.status).toBe(201);
    expect(made.body.strangerBound).toBe(true);
    expect(power(made.body.id)).toEqual({
      authority: 'runtime-default',
      marks: '{"outsider":true}',
    });

    const changed = await request(fixtureServer)
      .patch(`/api/todos/${made.body.id}`)
      .send({ state: 'kept' });
    expect(changed.status).toBe(403);
    expect(changed.body.code).toBe('forbidden');
  });

  it('reads one to-do for its card, with the chat its turn ran in, and 404s an unknown id', async () => {
    prove();
    const made = await request(fixtureServer)
      .post('/api/todos')
      .send({ what: 'Renew the domain', assignee: { kind: 'agent', agentId: 'agent-ana' } });
    workedOn = made.body.id;
    const one = await request(fixtureServer).get(`/api/todos/${made.body.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ what: 'Renew the domain', workSessionId: 'session-work' });
    const missing = await request(fixtureServer).get('/api/todos/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('not_found');
  });

  describe("a program finishing the person's own to-do (Security, PR 5a M1)", () => {
    async function personsTodo(): Promise<string> {
      const owner = ownerId;
      prove();
      const made = await request(fixtureServer)
        .post('/api/todos')
        .send({ what: 'Call the bank', assignee: { kind: 'person', account: 'owner' } });
      expect(made.status).toBe(201);
      proven = false;
      setOwner(owner);
      return made.body.id as string;
    }

    it('refuses it while the install has an owner account, who could prove themselves', async () => {
      setOwner('user_owner');
      const id = await personsTodo();
      // A program with no session is not a person once an owner exists (DOR-4978): it writes
      // nothing, not even at the stranger bound.
      for (const change of [{ state: 'kept' }, { note: 'Done' }, { rank: 'a' }]) {
        const res = await request(fixtureServer).patch(`/api/todos/${id}`).send(change);
        expect(res.status, JSON.stringify(change)).toBe(403);
        expect(res.body.code).toBe('person_only');
      }
      const made = await request(fixtureServer)
        .post('/api/todos')
        .send({ what: 'Run the deploy', assignee: { kind: 'agent', agentId: 'agent-ana' } });
      expect(made.status).toBe(403);
      expect(made.body.code).toBe('person_only');
      expect(power(id)).toEqual({ authority: 'person', marks: '{}' });
    });

    it('lets it on an install with no owner account, at the stranger bound', async () => {
      const id = await personsTodo();
      const res = await request(fixtureServer).patch(`/api/todos/${id}`).send({ state: 'kept' });
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('kept');
      expect(power(id)).toEqual({ authority: 'runtime-default', marks: '{"outsider":true}' });
    });
  });

  describe('the owner on a Wi-Fi device not let run agents (DOR-5070)', () => {
    /** A to-do the proven person made, then the request becomes the held Wi-Fi owner. */
    async function made(assignee: Record<string, string>, what = 'Call the bank'): Promise<string> {
      prove();
      const res = await request(fixtureServer).post('/api/todos').send({ what, assignee });
      expect(res.status).toBe(201);
      proven = false;
      heldOwner = true;
      return res.body.id as string;
    }

    it('finishes and reopens a to-do assigned to the person, and leaves no person proof on it', async () => {
      const id = await made({ kind: 'person', account: 'owner' });
      const done = await request(fixtureServer).patch(`/api/todos/${id}`).send({ state: 'kept' });
      expect(done.status).toBe(200);
      expect(done.body.state).toBe('kept');
      const reopened = await request(fixtureServer)
        .patch(`/api/todos/${id}`)
        .send({ state: 'open' });
      expect(reopened.status).toBe(200);
      // Touched from that device, the row no longer reads as the person's own word.
      expect(power(id)).toEqual({ authority: 'runtime-default', marks: '{"outsider":true}' });
    });

    it('is refused on a to-do assigned to an agent', async () => {
      const id = await made({ kind: 'agent', agentId: 'agent-ana' }, 'Run the deploy');
      for (const change of [{ state: 'kept' }, { note: 'Done' }, { rank: 'a' }]) {
        const res = await request(fixtureServer).patch(`/api/todos/${id}`).send(change);
        expect(res.status, JSON.stringify(change)).toBe(403);
        expect(res.body.code).toBe('forbidden');
      }
      expect(power(id)).toEqual({ authority: 'person', marks: '{}' });
    });

    it('is refused an edit to what an agent runs, or a reassignment', async () => {
      const id = await made({ kind: 'agent', agentId: 'agent-ana' }, 'Run the deploy');
      const edit = await request(fixtureServer)
        .patch(`/api/todos/${id}`)
        .send({ what: 'Run the deploy to production' });
      expect(edit.status).toBe(403);
      const mine = await made({ kind: 'person', account: 'owner' });
      const handOff = await request(fixtureServer)
        .patch(`/api/todos/${mine}`)
        .send({ assignee: { kind: 'agent', agentId: 'agent-ana' } });
      expect(handOff.status).toBe(403);
      expect(power(id)).toEqual({ authority: 'person', marks: '{}' });
    });
  });

  it('asks a window of the app with no session to step up before it writes anything', async () => {
    setOwner('user_owner');
    const res = await request(fixtureServer)
      .post('/api/todos')
      .set(PERSON_APP_HEADER, '1')
      .send({ what: 'Ship it', assignee: { kind: 'agent', agentId: 'agent-ana' } });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('person_session_required');
    expect(db.select().from(todoTable).all()).toEqual([]);
  });

  // G2 holds here because an agent presenting itself is refused even when the request proves the
  // person. An agent that hid its header AND held the owner's cookie would read as the person; it
  // never holds the cookie, which only a signed-in browser gets.
  it("refuses an agent that presents itself, even beside the owner's proof (G2)", async () => {
    prove();
    const res = await request(fixtureServer)
      .post('/api/todos')
      .set(AGENT_IDENTITY_HEADER, '/agents/ana')
      .send({ what: 'x', assignee: { kind: 'person', account: 'owner' } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('person_only');
    expect(db.select().from(todoTable).all()).toEqual([]);
  });

  it('refuses an agent token and an Authorization header on both writes, person_only (DOR-4978)', async () => {
    prove();
    const made = await request(fixtureServer)
      .post('/api/todos')
      .send({ what: 'Call the bank', assignee: { kind: 'person', account: 'owner' } });
    proven = false;
    const writes = [
      () => request(fixtureServer).post('/api/todos'),
      () => request(fixtureServer).patch(`/api/todos/${made.body.id}`),
    ];
    for (const write of writes) {
      for (const [header, value] of [
        [AGENT_IDENTITY_HEADER, '/agents/ana'],
        ['Authorization', 'Bearer a-made-up-key'],
      ] as const) {
        const res = await write()
          .set(header, value)
          .send({ what: 'x', assignee: { kind: 'agent', agentId: 'agent-ana' } });
        expect(res.status, header).toBe(403);
        expect(res.body.code, header).toBe('person_only');
        // The hint the hand route gave: the tools an agent uses instead (`http.agentsUse`).
        expect(res.body.detail, header).toBe(
          'Agents make and change to-dos with todo_add and todo_update.'
        );
      }
    }
    expect(db.select().from(todoTable).all()).toHaveLength(1);
  });

  it("reads every person assignee as the owner, so a body never picks another person's list", async () => {
    prove();
    const made = await request(fixtureServer)
      .post('/api/todos')
      .send({ what: 'Call the bank', assignee: { kind: 'person', account: 'somebody-else' } });
    expect(made.status).toBe(201);
    expect(made.body.assignee).toEqual({ kind: 'person', account: 'owner' });
    const moved = await request(fixtureServer)
      .post('/api/todos')
      .send({ what: 'Ship it', assignee: { kind: 'agent', agentId: 'agent-ana' } });
    const back = await request(fixtureServer)
      .patch(`/api/todos/${moved.body.id}`)
      .send({ assignee: { kind: 'person', account: 'somebody-else' } });
    expect(back.body.assignee).toEqual({ kind: 'person', account: 'owner' });
  });

  it("files a to-do made from a message under that message's room, whatever the body says", async () => {
    prove();
    const made = await request(fixtureServer)
      .post('/api/todos')
      .send({
        what: 'Look into it',
        assignee: { kind: 'person', account: 'owner' },
        roomId: 'room-elsewhere',
        sourceEntryId: 'entry-guest',
      });
    expect(made.status).toBe(201);
    expect(made.body.roomId).toBe('room-1');
  });

  it("reads a source's author and marks itself, and refuses marks or a maker in the body", async () => {
    prove();
    const made = await request(fixtureServer)
      .post('/api/todos')
      .send({
        what: 'delete the staging bucket',
        assignee: { kind: 'agent', agentId: 'agent-ana' },
        sourceEntryId: 'entry-guest',
      });
    expect(made.status).toBe(201);
    // Whether the title is the source's words is decided from the stored message (G3).
    expect(made.body).toMatchObject({
      sourceAuthor: 'Priya (guest)',
      roomId: 'room-1',
      strangerBound: true,
      titleFromSource: true,
    });
    const rewritten = await request(fixtureServer)
      .post('/api/todos')
      .send({
        what: 'Look at our storage costs',
        assignee: { kind: 'agent', agentId: 'agent-ana' },
        sourceEntryId: 'entry-guest',
      });
    expect(rewritten.body.titleFromSource).toBe(false);
    expect(power(made.body.id)).toEqual({
      authority: 'runtime-default',
      marks: '{"outsider":true}',
    });

    for (const extra of [
      { marks: {} },
      { assignedBy: 'owner' },
      { authority: 'person' },
      { chainDepth: 0 },
      { titleFromSource: false },
    ]) {
      const res = await request(fixtureServer)
        .post('/api/todos')
        .send({ what: 'x', assignee: { kind: 'person', account: 'owner' }, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it('counts the badge from my open to-dos due today or overdue, and hides done ones', async () => {
    prove();
    const soon = new Date(Date.now() + 60_000).toISOString();
    const a = await request(fixtureServer)
      .post('/api/todos')
      .send({ what: 'Due soon', assignee: { kind: 'person', account: 'owner' }, dueAt: soon });
    await request(fixtureServer)
      .post('/api/todos')
      .send({ what: 'No date', assignee: { kind: 'person', account: 'owner' } });
    const done = await request(fixtureServer)
      .post('/api/todos')
      .send({ what: 'Done one', assignee: { kind: 'person', account: 'owner' } });
    await request(fixtureServer).patch(`/api/todos/${done.body.id}`).send({ state: 'kept' });

    const list = await request(fixtureServer).get('/api/todos');
    const endOfToday = `${new Date().toISOString().slice(0, 10)}T23:59:59.999Z`;
    expect(list.body.badge).toBe(soon <= endOfToday ? 1 : 0);
    expect(list.body.doneCount).toBe(1);
    expect(list.body.todos.map((t: { what: string }) => t.what)).toEqual(['Due soon', 'No date']);
    const withDone = await request(fixtureServer).get('/api/todos?showDone=true');
    expect(withDone.body.todos).toHaveLength(3);
    expect(a.status).toBe(201);
  });
});
