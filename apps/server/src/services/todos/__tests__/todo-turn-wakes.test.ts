/**
 * A to-do's turn is a wake (spec `turns-survive-restarts` §6.3, T7): the
 * `todo_turns` row that counts it and the wake that starts it are one write,
 * keyed by the row's id. What the wake does after that (a restart survived, one
 * turn per key) is the run record's: `services/runs/__tests__/wake-chat.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { todos as todoTable, eq, todoTurns, type Db, type TodoRow } from '@dorkos/db';
import type { WakeRequest } from '@dorkos/shared/turn-port';
import { AuditLog } from '../../audit/audit-log.js';
import { AccountIds } from '../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../audit/audit-trail.js';
import { TodoService } from '../todo-service.js';
import { TodoStore } from '../todo-store.js';
import { TodoTurns } from '../todo-turns.js';
import type { TodoActor } from '../todo-authority.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const PERSON: TodoActor = { kind: 'person', proven: true };

let db: Db;
let todos: TodoService;

/** To-do turns over the test database, saving wakes through `wake`. */
function turnsWith(wake: (request: WakeRequest) => boolean): TodoTurns {
  return new TodoTurns({
    db,
    prepare: async (request) => ({ sessionId: 'chat-1', content: request.content, tier: 'owner' }),
    wake,
    isPaused: () => false,
    sharedBudget: () => true,
    readSource: () => undefined,
  });
}

/** A to-do the person gave an agent, as stored. */
function personTodo(what: string): TodoRow {
  const made = todos.create(PERSON, { what, assignee: { kind: 'agent', agentId: 'agent-a' } });
  return db.select().from(todoTable).where(eq(todoTable.id, made.id)).get()!;
}

beforeEach(() => {
  db = createTestDb();
  initAuditTrail({
    log: new AuditLog(db),
    accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
  });
  todos = new TodoService({
    store: new TodoStore(db),
    agentExists: (id) => id === 'agent-a',
    mayAssign: () => true,
    rearm: () => undefined,
  });
});

afterEach(() => resetAuditTrail());

describe('a to-do turn’s wake', () => {
  it('is saved with the row that counts it, keyed by the row, as a chat message', async () => {
    // Purpose: fails if the wake were keyed by anything but the ledger row.
    const wakes: WakeRequest[] = [];
    await turnsWith((request) => wakes.push(request) > 0).request(personTodo('Ship it'), null);
    const [row, ...more] = db.select().from(todoTurns).all();
    expect(more).toEqual([]);
    expect(row).toMatchObject({ status: 'started', sessionId: 'chat-1' });
    expect(wakes).toEqual([
      {
        sourceKind: 'todo',
        eventId: row!.id,
        start: expect.objectContaining({ sessionId: 'chat-1', origin: { kind: 'chat-message' } }),
      },
    ]);
  });

  it('takes its row with it when it cannot be saved: nothing is counted that will not run', async () => {
    const turns = turnsWith(() => {
      throw new Error('the outbox is gone');
    });
    await expect(turns.request(personTodo('Ship it'), null)).rejects.toThrow(/outbox/);
    expect(db.select().from(todoTurns).all()).toEqual([]);
  });
});
