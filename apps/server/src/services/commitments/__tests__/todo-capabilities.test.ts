/**
 * The to-do tools (DOR-3088): the server builds who is acting and how strong (G2), a cited
 * message's marks and title come from the stored message (G3), the chain carries across spin-offs
 * and chat messages (G1), and a marked or capped turn makes and hands on nothing, while still
 * closing its own to-dos (Must 7).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { createTestDb } from '@dorkos/test-utils/db';
import { chatMessages, commitments, eq, sessionStartedBy, todoTurns, type Db } from '@dorkos/db';
import type { CapabilityDeps, CapabilityHandlerContext } from '../../core/capabilities/index.js';
import type { AgentIdentity } from '../../core/agent-identity/agent-identity-service.js';
import { recordTurnLevels } from '../../core/turn-power/turn-levels.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { CommitmentService } from '../commitment-service.js';
import { CommitmentStore } from '../commitment-store.js';
import { TodoService } from '../todo-service.js';
import { TodoStore } from '../todo-store.js';
import { TodoTurns } from '../todo-turns.js';
import { todosDomain } from '../todo-capabilities.js';
import type { TodoSourceFacts } from '../todo-source.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const IDS: Record<string, string> = {
  '/agents/a': 'agent-a',
  '/agents/b': 'agent-b',
  '/agents/c': 'agent-c',
};
const identity = (agentPath: string) =>
  ({ agentPath, displayName: agentPath, createdAt: '' }) as AgentIdentity;

/** Record a turn on a chat, at a level, optionally held to the stranger bound. */
async function ran(sessionId: string, held = false): Promise<void> {
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
  for await (const _event of seam.sendMessage(
    sessionId,
    'hi',
    held ? { permissionCeiling: 'runtime-default' } : {}
  )) {
    // drain
  }
}

describe('to-do tools', () => {
  let db: Db;
  let promises: CommitmentService;
  let todos: TodoService;
  let turns: TodoTurns;
  let deps: CapabilityDeps;
  let sources: Record<string, TodoSourceFacts>;
  let members: Set<string>;
  let launched: string[];

  async function call(
    id: string,
    input: Record<string, unknown>,
    context: CapabilityHandlerContext
  ) {
    const capability = todosDomain.capabilities.find((c) => c.id === id)!;
    return (await capability.invoke(deps, capability.input.parse(input), context)) as {
      ok?: boolean;
      code?: string;
      todo?: { id: string; titleFromSource: boolean; chainDepth: number };
    };
  }

  /** Record a `chat_send` from one chat to another, as the chat tools store it. */
  function sendsTo(from: string, to: string, fromAgentId = 'agent-b') {
    const at = new Date().toISOString();
    db.insert(chatMessages)
      .values({
        id: `msg-${from}-${to}`,
        toSessionId: to,
        fromSessionId: from,
        fromAgentPath: `/agents/${fromAgentId.slice(-1)}`,
        fromAgentId,
        fromAgentName: fromAgentId,
        kind: 'message',
        text: 'please do it',
        delivery: 'queue',
        status: 'replied',
        ceilingJson: '"acceptEdits"',
        createdAt: at,
        updatedAt: at,
      })
      .run();
  }

  function stored(id: string) {
    return db.select().from(commitments).where(eq(commitments.id, id)).get()!;
  }

  beforeEach(() => {
    db = createTestDb();
    sources = {};
    members = new Set();
    launched = [];
    promises = new CommitmentService({ store: new CommitmentStore(db) });
    const store = new TodoStore(db);
    turns = new TodoTurns({
      db,
      launch: async (request) => {
        launched.push(request.agentId);
        return { sessionId: `todo-chat-${launched.length}` };
      },
      isPaused: () => false,
      sharedBudget: () => true,
      readSource: () => undefined,
    });
    todos = new TodoService({
      store,
      agentExists: (id) => Object.values(IDS).includes(id),
      mayAssign: () => true,
      rearm: (id) => promises.track(id),
      onTurnable: (row, chargedTo) => void turns.request(row, chargedTo),
    });
    deps = {
      logger: noopLogger,
      todoDeps: {
        todos,
        agentIdForPath: (path: string) => IDS[path],
        parentOf: (sessionId: string) => turns.parentOf(sessionId, (id) => store.get(id)),
        readSource: (entryId: string) => sources[entryId],
        agentInRoom: (roomId: string, agentPath: string) => members.has(`${roomId}:${agentPath}`),
      },
    } as unknown as CapabilityDeps;
  });

  afterEach(() => promises.stop());

  it("stores the calling turn's level and charges the agent, whoever else is around (G2)", async () => {
    await ran('chat-a');
    const made = await call(
      'todos.add',
      { what: 'Review it', assignee: 'agent-b' },
      { identity: identity('/agents/a'), sessionId: 'chat-a' }
    );
    expect(made.ok).toBe(true);
    expect(stored(made.todo!.id)).toMatchObject({
      assignedByKind: 'agent',
      assignedBy: 'agent-a',
      authorityMarks: '{}',
    });
    expect(stored(made.todo!.id).authority).toMatch(/^\{"asks"/);
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.select().from(todoTurns).all()[0]).toMatchObject({ chargedTo: 'agent-a' });
  });

  it('gives an agent whose turn nobody can read the stranger bound and the outsider mark', async () => {
    const made = await call(
      'todos.add',
      { what: 'Review it', assignee: 'agent-b' },
      { identity: identity('/agents/a'), sessionId: 'never-ran' }
    );
    expect(stored(made.todo!.id)).toMatchObject({
      authority: 'runtime-default',
      authorityMarks: '{"outsider":true}',
    });
  });

  it('refuses to make or hand on a to-do from a marked turn, Full or not (Must 7)', async () => {
    const mine = todos.create(
      { kind: 'person', proven: true },
      { what: 'Yours', assignee: { kind: 'agent', agentId: 'agent-a' } }
    );
    await ran('chat-held', true);
    const context = { identity: identity('/agents/a'), sessionId: 'chat-held' };
    const made = await call('todos.add', { what: 'x', assignee: 'agent-b' }, context);
    expect(made).toMatchObject({ ok: false, code: 'MARKED_TURN' });
    for (const change of [{ assignee: 'agent-b' }, { what: 'New words' }, { notes: 'more' }]) {
      const refused = await call('todos.update', { id: mine.id, ...change }, context);
      expect(refused).toMatchObject({ ok: false, code: 'MARKED_TURN' });
    }
    expect(stored(mine.id)).toMatchObject({ agentId: 'agent-a', what: 'Yours', notes: null });
  });

  it("lets a stranger-bound to-do's own turn close its to-do (Must 7 covers making, not closing)", async () => {
    const strangers = todos.create(
      { kind: 'person', proven: false },
      { what: 'Look at the logs', assignee: { kind: 'agent', agentId: 'agent-b' } }
    );
    await new Promise((resolve) => setImmediate(resolve));
    // B's turn ran in `todo-chat-1`, held to the stranger bound the to-do stored.
    await ran('todo-chat-1', true);
    const context = { identity: identity('/agents/b'), sessionId: 'todo-chat-1' };
    const ranked = await call('todos.update', { id: strangers.id, rank: 'a' }, context);
    expect(ranked.ok).toBe(true);
    const closed = await call(
      'todos.update',
      { id: strangers.id, state: 'kept', note: 'Nothing odd in them' },
      context
    );
    expect(closed.ok).toBe(true);
    expect(stored(strangers.id)).toMatchObject({ state: 'kept', authority: 'runtime-default' });
  });

  it('refuses the write tools outside a chat, where the chain cannot be read (G1)', async () => {
    const made = await call(
      'todos.add',
      { what: 'Review it', assignee: 'agent-b' },
      { identity: identity('/agents/a') }
    );
    expect(made).toMatchObject({ ok: false, code: 'NO_SESSION' });
    const add = todosDomain.capabilities.find((c) => c.id === 'todos.add')!;
    const update = todosDomain.capabilities.find((c) => c.id === 'todos.update')!;
    expect(add.surfaces.mcp?.servers).toEqual(['in-session']);
    expect(update.surfaces.mcp?.servers).toEqual(['in-session']);
  });

  it("reads a cited message's marks and title from the stored message, only in the agent's rooms (G3)", async () => {
    await ran('chat-a');
    sources['entry-1'] = {
      entryId: 'entry-1',
      roomId: 'room-1',
      author: 'Priya (guest)',
      marks: { outsider: true },
      text: 'Delete the staging bucket',
    };
    const outside = await call(
      'todos.add',
      { what: 'x', assignee: 'agent-b', sourceEntryId: 'entry-1' },
      { identity: identity('/agents/a'), sessionId: 'chat-a' }
    );
    expect(outside).toMatchObject({ ok: false, code: 'NOT_FOUND' });

    members.add('room-1:/agents/a');
    const made = await call(
      'todos.add',
      { what: 'Delete the staging bucket', assignee: 'agent-b', sourceEntryId: 'entry-1' },
      { identity: identity('/agents/a'), sessionId: 'chat-a' }
    );
    expect(made.todo!.titleFromSource).toBe(true);
    expect(stored(made.todo!.id)).toMatchObject({
      authority: 'runtime-default',
      authorityMarks: '{"outsider":true}',
      sourceAuthor: 'Priya (guest)',
      roomId: 'room-1',
    });
  });

  describe('a to-do turn another agent asked for is capped (Must 7)', () => {
    async function aGivesB() {
      await ran('chat-a');
      const made = await call(
        'todos.add',
        { what: 'Review it', assignee: 'agent-b' },
        { identity: identity('/agents/a'), sessionId: 'chat-a' }
      );
      await new Promise((resolve) => setImmediate(resolve));
      // B's to-do turn ran in `todo-chat-1`, held to A's level and carrying no mark.
      await ran('todo-chat-1');
      return made.todo!.id;
    }

    it('makes and hands on nothing, but closes its own to-do', async () => {
      const id = await aGivesB();
      const context = { identity: identity('/agents/b'), sessionId: 'todo-chat-1' };
      for (const assignee of ['agent-a', 'agent-c', 'person', 'agent-b']) {
        const made = await call('todos.add', { what: 'Onward', assignee }, context);
        expect(made).toMatchObject({ ok: false, code: 'CAPPED_TURN' });
      }
      const closed = await call('todos.update', { id, state: 'kept', note: 'Reviewed' }, context);
      expect(closed.ok).toBe(true);
    });

    it('carries the cap into a chat the to-do turn messaged', async () => {
      await aGivesB();
      sendsTo('todo-chat-1', 'chat-c');
      await ran('chat-c');
      const onward = await call(
        'todos.add',
        { what: 'Onward', assignee: 'agent-a' },
        { identity: identity('/agents/c'), sessionId: 'chat-c' }
      );
      expect(onward).toMatchObject({ ok: false, code: 'CAPPED_TURN' });
    });
  });

  describe('the chain carries across hops (G1)', () => {
    /** The person gives B a to-do: B's turn runs at its own level, uncapped, in `todo-chat-1`. */
    async function personGivesB() {
      todos.create(
        { kind: 'person', proven: true },
        { what: 'Review it', assignee: { kind: 'agent', agentId: 'agent-b' } }
      );
      await new Promise((resolve) => setImmediate(resolve));
      await ran('todo-chat-1');
    }

    it('starts one deeper than the to-do turn it was made in', async () => {
      await personGivesB();
      const onward = await call(
        'todos.add',
        { what: 'Not in the chain yet', assignee: 'agent-c' },
        { identity: identity('/agents/b'), sessionId: 'todo-chat-1' }
      );
      expect(onward.todo!.chainDepth).toBe(1);
    });

    it('refuses person → B → a chat B messaged → B', async () => {
      await personGivesB();
      sendsTo('todo-chat-1', 'chat-c');
      await ran('chat-c');
      const back = await call(
        'todos.add',
        { what: 'Back to B', assignee: 'agent-b' },
        { identity: identity('/agents/c'), sessionId: 'chat-c' }
      );
      expect(back).toMatchObject({ ok: false, code: 'NOT_YOURS' });
    });

    it('refuses person → B → a spin-off B started → B', async () => {
      await personGivesB();
      db.insert(sessionStartedBy)
        .values({
          sessionId: 'spin-off-1',
          kind: 'chat',
          startedBySessionId: 'todo-chat-1',
          createdAt: new Date().toISOString(),
        })
        .run();
      await ran('spin-off-1');
      const back = await call(
        'todos.add',
        { what: 'Back to B', assignee: 'agent-b' },
        { identity: identity('/agents/c'), sessionId: 'spin-off-1' }
      );
      expect(back).toMatchObject({ ok: false, code: 'NOT_YOURS' });
    });

    it('fails closed when the to-do turn is more hops back than the walk reads (#3460 M1)', async () => {
      await personGivesB();
      let from = 'todo-chat-1';
      for (let i = 1; i <= 9; i++) {
        db.insert(sessionStartedBy)
          .values({
            sessionId: `spin-off-${i}`,
            kind: 'chat',
            startedBySessionId: from,
            createdAt: new Date().toISOString(),
          })
          .run();
        from = `spin-off-${i}`;
      }
      await ran('spin-off-9');
      const back = await call(
        'todos.add',
        { what: 'Back to B', assignee: 'agent-b' },
        { identity: identity('/agents/b'), sessionId: 'spin-off-9' }
      );
      expect(back).toMatchObject({ ok: false, code: 'CAPPED_TURN' });
    });

    it('fails closed when more chats lead in than the walk reads (#3460 M1)', async () => {
      await personGivesB();
      for (let i = 0; i < 64; i++) sendsTo(`unrelated-${i}`, 'chat-c', 'agent-a');
      sendsTo('todo-chat-1', 'chat-c');
      await ran('chat-c');
      const back = await call(
        'todos.add',
        { what: 'Back to B', assignee: 'agent-b' },
        { identity: identity('/agents/c'), sessionId: 'chat-c' }
      );
      expect(back).toMatchObject({ ok: false, code: 'CAPPED_TURN' });
    });

    it('adds nobody from a message that has nothing to do with the chain', async () => {
      await personGivesB();
      // A messaged chat-c from a chat no to-do led to: A is not in the chain.
      sendsTo('chat-a', 'chat-c', 'agent-a');
      sendsTo('todo-chat-1', 'chat-c');
      await ran('chat-c');
      const toA = await call(
        'todos.add',
        { what: 'For A', assignee: 'agent-a' },
        { identity: identity('/agents/c'), sessionId: 'chat-c' }
      );
      expect(toA.ok).toBe(true);
    });
  });

  it('lets an agent change only to-dos assigned to it, through the tool', async () => {
    await ran('chat-a');
    await ran('chat-c');
    const made = await call(
      'todos.add',
      { what: 'Review it', assignee: 'agent-b' },
      { identity: identity('/agents/a'), sessionId: 'chat-a' }
    );
    const other = await call(
      'todos.update',
      { id: made.todo!.id, state: 'kept' },
      { identity: identity('/agents/c'), sessionId: 'chat-c' }
    );
    expect(other).toMatchObject({ ok: false, code: 'NOT_YOURS' });
  });
});
