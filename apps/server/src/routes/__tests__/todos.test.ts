/**
 * The to-do routes (DOR-3088): views and the badge, person authority only with proof, an app
 * window asked to step up before it writes, agents sent to their tools, and a source's marks read
 * by the server, never the body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ ownerId: 'user_owner' as string | null }));
vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));
vi.mock('../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => (state.ownerId ? { id: state.ownerId } : null),
  hasAnyUser: () => state.ownerId !== null,
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { commitments, eq, type Db } from '@dorkos/db';
import { PERSON_APP_HEADER } from '@dorkos/shared/person-session';
import { createTodosRoutes } from '../todos.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { AGENT_IDENTITY_HEADER } from '../../middleware/agent-identity.js';
import { CommitmentService } from '../../services/commitments/commitment-service.js';
import { CommitmentStore } from '../../services/commitments/commitment-store.js';
import { TodoService } from '../../services/commitments/todo-service.js';
import { TodoStore } from '../../services/commitments/todo-store.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

describe('to-do routes', () => {
  let db: Db;
  let promises: CommitmentService;
  let todos: TodoService;
  /** Whether the request proves the person; flipped per test. */
  let proven: boolean;
  /** The to-do whose turn has run, for "Show work". */
  let workedOn: string | undefined;

  function power(id: string) {
    return db
      .select({ authority: commitments.authority, marks: commitments.authorityMarks })
      .from(commitments)
      .where(eq(commitments.id, id))
      .get();
  }

  beforeEach(() => {
    state.ownerId = null;
    proven = false;
    db = createTestDb();
    promises = new CommitmentService({ store: new CommitmentStore(db) });
    todos = new TodoService({
      store: new TodoStore(db),
      agentExists: (id) => id === 'agent-ana',
      mayAssign: () => true,
      rearm: (id) => promises.track(id),
    });
    const app = honoGroupListener(
      [
        {
          path: '/api/todos',
          routes: createTodosRoutes({
            todos,
            personProven: () => proven,
            ownerExists: () => state.ownerId !== null,
            workSessionOf: (todoId) => (todoId === workedOn ? 'session-work' : null),
            // The app's marker stands in for a window with no session while an owner exists.
            needsStepUp: (facts) =>
              state.ownerId !== null && facts.headers[PERSON_APP_HEADER] !== undefined,
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
          }),
        },
      ],
      {
        before: (c, next) => {
          if (c.req.header(AGENT_IDENTITY_HEADER)) {
            c.set('agentIdentity', { agentPath: '/agents/ana', displayName: 'ana', createdAt: '' });
          }
          return next();
        },
      }
    );
    fixtureTarget.mount(app);
  });

  afterEach(() => promises.stop());

  it("makes a proven person's to-do with person authority, and lists it under Assigned to me", async () => {
    proven = true;
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

  it('gives a program with no session the stranger bound, shown on the to-do, and lets it change nothing', async () => {
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
    expect(changed.body.code).toBe('NOT_YOURS');
  });

  it('reads one to-do for its card, with the chat its turn ran in, and 404s an unknown id', async () => {
    proven = true;
    const made = await request(fixtureServer)
      .post('/api/todos')
      .send({ what: 'Renew the domain', assignee: { kind: 'agent', agentId: 'agent-ana' } });
    workedOn = made.body.id;
    const one = await request(fixtureServer).get(`/api/todos/${made.body.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ what: 'Renew the domain', workSessionId: 'session-work' });
    const missing = await request(fixtureServer).get('/api/todos/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });

  describe("a program finishing the person's own to-do (Security, PR 5a M1)", () => {
    async function personsTodo(): Promise<string> {
      proven = true;
      const made = await request(fixtureServer)
        .post('/api/todos')
        .send({ what: 'Call the bank', assignee: { kind: 'person', account: 'owner' } });
      expect(made.status).toBe(201);
      proven = false;
      return made.body.id as string;
    }

    it('refuses it while the install has an owner account, who could prove themselves', async () => {
      state.ownerId = 'user_owner';
      const id = await personsTodo();
      for (const change of [{ state: 'kept' }, { note: 'Done' }, { rank: 'a' }]) {
        const res = await request(fixtureServer).patch(`/api/todos/${id}`).send(change);
        expect(res.status, JSON.stringify(change)).toBe(403);
        expect(res.body.code).toBe('NOT_YOURS');
      }
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

  it('asks a window of the app with no session to step up before it writes anything', async () => {
    state.ownerId = 'user_owner';
    const res = await request(fixtureServer)
      .post('/api/todos')
      .set(PERSON_APP_HEADER, '1')
      .send({ what: 'Ship it', assignee: { kind: 'agent', agentId: 'agent-ana' } });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('person_session_required');
    expect(db.select().from(commitments).all()).toEqual([]);
  });

  // G2 holds here because an agent presenting itself is refused even when the request proves the
  // person. An agent that hid its header AND held the owner's cookie would read as the person; it
  // never holds the cookie, which only a signed-in browser gets.
  it("refuses an agent that presents itself, even beside the owner's proof (G2)", async () => {
    proven = true;
    const res = await request(fixtureServer)
      .post('/api/todos')
      .set(AGENT_IDENTITY_HEADER, '/agents/ana')
      .send({ what: 'x', assignee: { kind: 'person', account: 'owner' } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_A_PERSON');
    expect(db.select().from(commitments).all()).toEqual([]);
  });

  it("reads every person assignee as the owner, so a body never picks another person's list", async () => {
    proven = true;
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
    proven = true;
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
    proven = true;
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
    proven = true;
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
