/**
 * A to-do or a promise an agent makes in a chat is recorded in the work graph
 * (DOR-5266): the chat `produced` `dork:todo:<id>`. Driven through the real
 * to-do capabilities, the real to-do and promise services over a real
 * database, the real edge store, and the composition root's own wiring.
 *
 * One row per caller kind:
 *
 * | caller                                   | where its chat comes from          |
 * | ---------------------------------------- | ---------------------------------- |
 * | `todo_add` (an agent, in-session)        | the in-session live session        |
 * | `todo_promise_add`, in-session           | the in-session live session        |
 * | `todo_promise_add`, external or HTTP     | the chat the agent token is bound to |
 * | `todos.add_as_person` (the app)          | none: a person's write names none  |
 * | `todos.add_promise_for_agent` (the app)  | none: a person's write names none  |
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { createTestDb } from '@dorkos/test-utils/db';
import { sql, todos as todoTable, workLinks, eq, type Db } from '@dorkos/db';
import type {
  CapabilityDeps,
  CapabilityHandlerContext,
  CapabilityRequestFacts,
} from '../../../services/core/capabilities/index.js';
import type { AgentIdentity } from '../../../services/core/agent-identity/agent-identity-service.js';
import { recordTurnLevels } from '../../../services/core/turn-power/turn-levels.js';
import { resetLiveOutsiderTurns } from '../../../services/core/turn-power/live-outsider-turns.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../services/runtimes/claude-code/runtime-constants.js';
import { TodoPromiseService } from '../../../services/todos/todo-promise-service.js';
import { TodoPromiseStore } from '../../../services/todos/todo-promise-store.js';
import { TodoService } from '../../../services/todos/todo-service.js';
import { TodoStore } from '../../../services/todos/todo-store.js';
import { todosDomain } from '../../../services/todos/todo-capabilities.js';
import { todoPromisesDomain } from '../../../services/todos/todo-promise-capabilities.js';
import { todoWriteDomain } from '../../../services/todos/todo-write-capabilities.js';
import { todoPromiseHttpDomain } from '../../../services/todos/todo-http-capabilities.js';
import { onTodoMadeInChat } from '../../../services/todos/index.js';
import {
  installWorkLinkStore,
  recordChatRekey,
  recordChatTodo,
  uninstallWorkLinkStore,
} from '../../../services/work-graph/index.js';
import { wireTodoLinks } from '../work-graph.js';

const CHAT = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
const OTHER_CHAT = '7c6b5a49-3e2d-4c1b-9a08-f7e6d5c4b3a2';
const NEW_CHAT_ID = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const AGENT_IDS: Record<string, string> = { '/agents/ana': 'agent-ana', '/agents/bo': 'agent-bo' };

const ana = (extra: Partial<AgentIdentity> = {}) =>
  ({ agentPath: '/agents/ana', displayName: 'Ana', createdAt: '', ...extra }) as AgentIdentity;
const person = { ownerProven: true } as unknown as CapabilityRequestFacts;

let db: Db;
let todos: TodoService;
let promises: TodoPromiseService;
let deps: CapabilityDeps;
let stopWiring: () => void;

/** Record a clean turn on `sessionId`, so a tool call from it is the agent's own turn. */
async function ranClean(sessionId: string): Promise<void> {
  const seam = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'acceptEdits'
  );
  for await (const _event of seam.sendMessage(sessionId, 'hi', {})) {
    // drain
  }
}

/** Invoke one capability of the to-do domains, parsed the way the registry does. */
async function call(
  id: string,
  input: Record<string, unknown>,
  context: CapabilityHandlerContext
): Promise<{ ok?: boolean; id?: string; todo?: { id: string }; todoPromise?: { id: string } }> {
  const capability = [
    ...todosDomain.capabilities,
    ...todoPromisesDomain.capabilities,
    ...todoWriteDomain.capabilities,
    ...todoPromiseHttpDomain.capabilities,
  ].find((c) => c.id === id);
  if (!capability) throw new Error(`no capability ${id}`);
  return (await capability.invoke(deps, capability.input.parse(input), context)) as never;
}

/** Every recorded `produced` edge, as `<from> <to>`. */
function produced(): string[] {
  return db
    .select()
    .from(workLinks)
    .where(eq(workLinks.relation, 'produced'))
    .all()
    .map((row) => `${row.fromRef} ${row.toRef}`)
    .sort();
}

const madeTodos = () => db.select().from(todoTable).all();

beforeEach(() => {
  db = createTestDb();
  promises = new TodoPromiseService({ store: new TodoPromiseStore(db) });
  const store = new TodoStore(db);
  todos = new TodoService({
    store,
    agentExists: (id) => Object.values(AGENT_IDS).includes(id),
    mayAssign: () => true,
    rearm: (id) => promises.track(id),
  });
  const owner = { isOwner: () => true, personProven: () => true, ownerExists: () => true };
  deps = {
    logger: noopLogger,
    todoDeps: {
      todos,
      agentIdForPath: (path: string) => AGENT_IDS[path],
      parentOf: () => undefined,
      readSource: () => undefined,
      agentInRoom: () => false,
    },
    todoPromiseDeps: { service: promises, agentIdForPath: (path: string) => AGENT_IDS[path] },
    todoWriteDeps: { todos, ownerExists: () => true, readSource: () => undefined },
    todoPromiseHttpDeps: {
      ...owner,
      service: promises,
      agentExists: (id: string) => Object.values(AGENT_IDS).includes(id),
    },
  } as unknown as CapabilityDeps;
  installWorkLinkStore(db);
  stopWiring = wireTodoLinks();
});

afterEach(() => {
  stopWiring();
  uninstallWorkLinkStore();
  promises.stop();
  resetLiveOutsiderTurns();
});

describe('what an agent makes from a chat’s turn', () => {
  it('a to-do from `todo_add` in-session: the live session produced it', async () => {
    await ranClean(CHAT);
    const made = await call(
      'todos.add',
      { what: 'Review it', assignee: 'agent-bo' },
      { identity: ana(), sessionId: CHAT }
    );

    expect(made.ok).toBe(true);
    expect(produced()).toEqual([`dork:chat:${CHAT} dork:todo:${made.todo!.id}`]);
  });

  it('a promise from `todo_promise_add` in-session: the live session produced it', async () => {
    await ranClean(CHAT);
    const made = await call(
      'todo_promises.add',
      { what: 'Send it' },
      {
        identity: ana(),
        sessionId: CHAT,
      }
    );

    expect(made.ok).toBe(true);
    expect(produced()).toEqual([`dork:chat:${CHAT} dork:todo:${made.todoPromise!.id}`]);
  });

  it('a promise from outside a session: the chat the agent token is bound to produced it', async () => {
    await ranClean(CHAT);
    const made = await call(
      'todo_promises.add',
      { what: 'Send it' },
      {
        identity: ana({ chatId: CHAT }),
      }
    );

    expect(made.ok).toBe(true);
    expect(produced()).toEqual([`dork:chat:${CHAT} dork:todo:${made.todoPromise!.id}`]);
  });

  it('lands on the chat’s current id when the chat was re-keyed', async () => {
    recordChatRekey(CHAT, NEW_CHAT_ID);
    await ranClean(CHAT);
    const made = await call(
      'todo_promises.add',
      { what: 'Send it' },
      {
        identity: ana({ chatId: NEW_CHAT_ID }),
        sessionId: CHAT,
      }
    );

    expect(produced()).toEqual([`dork:chat:${NEW_CHAT_ID} dork:todo:${made.todoPromise!.id}`]);
  });

  it('adds nothing on an exact repeat', async () => {
    await ranClean(CHAT);
    const made = await call(
      'todo_promises.add',
      { what: 'Send it' },
      {
        identity: ana(),
        sessionId: CHAT,
      }
    );
    recordChatTodo({ chatIds: [CHAT], todoId: made.todoPromise!.id });

    expect(produced()).toHaveLength(1);
  });

  it.each([
    ['todos.add', { what: 'Review it', assignee: 'agent-bo' }],
    ['todo_promises.add', { what: 'Send it' }],
  ])('%s still makes it when a listener throws and the link write fails', async (id, input) => {
    await ranClean(CHAT);
    // A listener heard before the work graph throws, and then the work graph's write fails.
    stopWiring();
    const stop = onTodoMadeInChat(() => {
      throw new Error('a listener that breaks');
    });
    stopWiring = wireTodoLinks();
    db.run(sql`DROP TABLE work_links`);
    try {
      const made = await call(id, input, { identity: ana(), sessionId: CHAT });

      expect(made.ok).toBe(true);
      expect(madeTodos()).toHaveLength(1);
      // The work graph's own write never throws either.
      expect(() => recordChatTodo({ chatIds: [CHAT], todoId: madeTodos()[0]!.id })).not.toThrow();
    } finally {
      stop();
    }
  });
});

describe('what records nothing', () => {
  it('a person’s to-do in the app, even on a call that names a chat', async () => {
    const made = await call(
      'todos.add_as_person',
      { what: 'Call the bank', assignee: { kind: 'person', account: 'owner' } },
      { request: person, sessionId: CHAT }
    );

    expect(made.id).toEqual(expect.any(String));
    expect(produced()).toEqual([]);
  });

  it('a person’s promise for an agent in the app, even on a call that names a chat', async () => {
    const made = await call(
      'todos.add_promise_for_agent',
      { agentId: 'agent-ana', what: 'Send it' },
      { request: person, sessionId: CHAT }
    );

    expect(made.id).toEqual(expect.any(String));
    expect(produced()).toEqual([]);
  });

  it('an agent’s promise with no session and a token no running chat holds', async () => {
    const made = await call('todo_promises.add', { what: 'Send it' }, { identity: ana() });

    expect(made.ok).toBe(true);
    expect(produced()).toEqual([]);
  });

  it('a call whose session and token name two different chats', async () => {
    await ranClean(CHAT);
    const made = await call(
      'todo_promises.add',
      { what: 'Send it' },
      {
        identity: ana({ chatId: OTHER_CHAT }),
        sessionId: CHAT,
      }
    );

    expect(made.ok).toBe(true);
    expect(produced()).toEqual([]);
  });
});
