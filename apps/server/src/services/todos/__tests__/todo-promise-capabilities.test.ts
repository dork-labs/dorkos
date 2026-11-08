/**
 * The `todos` capability domain (spec `heartbeats` §12): `todo_promise_add`
 * records the CALLING agent's promise only, `todo_promise_update` lets the
 * promising agent or a person change one and refuses another agent, and
 * `todo_promises_list` lets any agent read every agent's list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import type { TodoPromise } from '@dorkos/shared/todo-promise-schemas';
import { createTestDb } from '@dorkos/test-utils/db';
import { todos, eq, type Db } from '@dorkos/db';
import type { CapabilityDeps, CapabilityHandlerContext } from '../../core/capabilities/index.js';
import type { AgentIdentity } from '../../core/agent-identity/agent-identity-service.js';
import { todoPromisesDomain } from '../todo-promise-capabilities.js';
import { TodoPromiseService } from '../todo-promise-service.js';
import { TodoPromiseStore } from '../todo-promise-store.js';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { recordTurnLevels } from '../../core/turn-power/turn-levels.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

/** An agent identity at a home folder. */
function identityAt(agentPath: string, extra: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    agentPath,
    displayName: agentPath.split('/').pop()!,
    createdAt: '2026-10-10T09:00:00.000Z',
    ...extra,
  } as AgentIdentity;
}

const ana = identityAt('/agents/ana');
const bo = identityAt('/agents/bo');
const AGENT_IDS: Record<string, string> = { '/agents/ana': 'agent-ana', '/agents/bo': 'agent-bo' };

/** What the tools answer, loosely: a refusal, one to-do, or a list. */
interface CallResult {
  ok?: boolean;
  code?: string;
  todoPromise?: TodoPromise;
  todoPromises?: TodoPromise[];
  truncated?: boolean;
}

/** One capability of the domain, parsed and invoked the way the registry does. */
async function call(
  deps: CapabilityDeps,
  id: string,
  input: Record<string, unknown>,
  context: CapabilityHandlerContext
) {
  const capability = todoPromisesDomain.capabilities.find((c) => c.id === id);
  if (!capability) throw new Error(`to-dos domain does not declare ${id}`);
  const parsed = capability.input.parse(input);
  return (await capability.invoke(deps, parsed, context)) as CallResult;
}

/**
 * Record a turn on `sessionId` held to the runtime default, as a Wi-Fi turn is, in a chat set to
 * Ask first: a chat set to Full is not refused for its mark (DOR-3412, `todo-turn-marks`).
 */
async function ranHeld(sessionId: string): Promise<void> {
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
  for await (const _event of seam.sendMessage(sessionId, 'hi', {
    permissionCeiling: 'runtime-default',
  })) {
    // drain
  }
}

/** Record a clean turn on `sessionId`: a known level, no ceiling, no marks. */
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

describe('to-dos domain', () => {
  let service: TodoPromiseService;
  let deps: CapabilityDeps;
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
    db = createTestDb();
    service = new TodoPromiseService({ store: new TodoPromiseStore(db) });
    deps = {
      logger: noopLogger,
      todoPromiseDeps: {
        service,
        agentIdForPath: (agentPath: string) => AGENT_IDS[agentPath],
      },
    } as unknown as CapabilityDeps;
  });

  afterEach(() => service.stop());

  it('declares the three tools with no area, each with a written reason', () => {
    expect(
      todoPromisesDomain.capabilities.map((c) => [c.id, c.surfaces.mcp?.toolName, c.tier, c.area])
    ).toEqual([
      ['todo_promises.add', 'todo_promise_add', 'act', null],
      ['todo_promises.update', 'todo_promise_update', 'act', null],
      ['todo_promises.list', 'todo_promises_list', 'observe', null],
    ]);
    for (const c of todoPromisesDomain.capabilities) expect(c.areaNote).toBeTruthy();
  });

  it('tells an agent it is woken when a promise comes due: its beat does that (DOR-2788 PR 3)', () => {
    const add = todoPromisesDomain.capabilities.find((c) => c.id === 'todo_promises.add')!;
    expect(add.description).toContain('when it comes due you are woken to deal with it');
  });

  describe('a turn nobody can read is marked (Security, #3454 Must 1)', () => {
    it('stores self with the outsider mark for an unknown session and no running turn', async () => {
      const result = await call(
        deps,
        'todo_promises.add',
        { what: 'Reply after the restart' },
        { identity: ana, sessionId: 'never-ran-here' }
      );
      expect(power(result.todoPromise!.id)).toEqual({
        authority: 'self',
        marks: '{"outsider":true}',
      });
    });

    it('stores self with the outsider mark when the caller names no session at all', async () => {
      const result = await call(
        deps,
        'todo_promises.add',
        { what: 'Over /mcp' },
        { identity: ana }
      );
      expect(power(result.todoPromise!.id)).toEqual({
        authority: 'self',
        marks: '{"outsider":true}',
      });
    });

    it('stores no mark for a known clean level', async () => {
      await ranClean('chat-clean');
      const result = await call(
        deps,
        'todo_promises.add',
        { what: 'Reply in a recorded turn' },
        { identity: ana, sessionId: 'chat-clean' }
      );
      expect(power(result.todoPromise!.id)!.marks).toBe('{}');
    });

    it("adds the mark when an unreadable turn changes the agent's own promise", async () => {
      await ranClean('chat-clean');
      const made = await call(
        deps,
        'todo_promises.add',
        { what: 'Ship it' },
        { identity: ana, sessionId: 'chat-clean' }
      );
      expect(power(made.todoPromise!.id)!.marks).toBe('{}');
      await call(
        deps,
        'todo_promises.update',
        { id: made.todoPromise!.id, state: 'kept' },
        { identity: ana, sessionId: 'never-ran-here' }
      );
      expect(power(made.todoPromise!.id)!.marks).toBe('{"outsider":true}');
    });
  });

  describe('todo_promise_add', () => {
    it("records the calling agent's own promise, with its chat as the source", async () => {
      const result = await call(
        deps,
        'todo_promises.add',
        { what: 'Send Acme the quote', to: 'external:Acme', sourceEntryId: 'entry-1' },
        { identity: ana, sessionId: 'chat-ana', mcpServer: 'in-session' }
      );
      expect(result).toMatchObject({
        ok: true,
        todoPromise: {
          agentId: 'agent-ana',
          to: 'external:Acme',
          sourceSessionId: 'chat-ana',
          sourceRoomEntryId: 'entry-1',
          state: 'open',
        },
      });
    });

    it.each([
      ['no identity', {}],
      ['a revoked identity', { identity: identityAt('/agents/ana', { inactive: 'revoked' }) }],
    ] as const)('refuses with NO_AGENT for %s, recording nothing', async (_label, context) => {
      const result = await call(
        deps,
        'todo_promises.add',
        { what: 'Anything' },
        context as CapabilityHandlerContext
      );
      expect(result).toMatchObject({ ok: false, code: 'NO_AGENT' });
      expect(service.list()).toEqual([]);
    });

    it('refuses an agent Mesh does not know', async () => {
      const result = await call(
        deps,
        'todo_promises.add',
        { what: 'Anything' },
        { identity: identityAt('/agents/stranger') }
      );
      expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_AGENT' });
    });

    it('refuses a promise from a turn that read outsider words, such as a Wi-Fi turn (DOR-3037)', async () => {
      await ranHeld('chat-held');
      const result = await call(
        deps,
        'todo_promises.add',
        { what: 'Wipe the staging bucket at midnight' },
        { identity: ana, sessionId: 'chat-held', mcpServer: 'in-session' }
      );
      expect(result).toMatchObject({ ok: false, code: 'OUTSIDER_TURN' });
      expect(service.list()).toEqual([]);
    });

    it('refuses a promise longer than 300 characters before it reaches the service', async () => {
      await expect(
        call(deps, 'todo_promises.add', { what: 'x'.repeat(301) }, { identity: ana })
      ).rejects.toThrow();
    });
  });

  describe('todo_promise_update', () => {
    let id: string;

    beforeEach(async () => {
      const made = await call(deps, 'todo_promises.add', { what: 'Ship it' }, { identity: ana });
      id = made.todoPromise!.id;
    });

    it('lets the promising agent mark it kept', async () => {
      const result = await call(
        deps,
        'todo_promises.update',
        { id, state: 'kept' },
        { identity: ana }
      );
      expect(result).toMatchObject({ ok: true, todoPromise: { state: 'kept' } });
    });

    it('refuses another agent with NOT_YOURS, and the promise stays open', async () => {
      const result = await call(
        deps,
        'todo_promises.update',
        { id, state: 'dropped' },
        { identity: bo }
      );
      expect(result).toMatchObject({ ok: false, code: 'NOT_YOURS' });
      expect(service.get(id)!.state).toBe('open');
    });

    it('lets a person (no agent behind the call) drop it', async () => {
      const result = await call(deps, 'todo_promises.update', { id, state: 'dropped' }, {});
      expect(result).toMatchObject({ ok: true, todoPromise: { state: 'dropped' } });
    });

    it.each([
      ['an identity that did not verify', { agentIdentityPresented: true }],
      ['an in-session chat with no agent', { mcpServer: 'in-session', sessionId: 's1' }],
      ['a revoked agent', { identity: identityAt('/agents/ana', { inactive: 'revoked' }) }],
    ] as const)('never reads %s as a person', async (_label, context) => {
      const result = await call(
        deps,
        'todo_promises.update',
        { id, state: 'kept' },
        context as CapabilityHandlerContext
      );
      expect(result).toMatchObject({ ok: false, code: 'NO_AGENT' });
      expect(service.get(id)!.state).toBe('open');
    });
  });

  describe('todo_promises_list', () => {
    it('reads open promises only by default, and never shows the source chat', async () => {
      const made = await call(
        deps,
        'todo_promises.add',
        { what: 'Open one' },
        { identity: ana, sessionId: 'chat-ana' }
      );
      const closed = await call(deps, 'todo_promises.add', { what: 'Kept one' }, { identity: ana });
      service.update({ kind: 'person' }, closed.todoPromise!.id, { state: 'kept' });

      const byDefault = await call(deps, 'todo_promises.list', {}, { identity: bo });
      expect(byDefault.todoPromises!.map((c) => c.what)).toEqual(['Open one']);
      expect(byDefault.todoPromises![0]!.sourceSessionId).toBeNull();
      expect(service.get(made.todoPromise!.id)!.sourceSessionId).toBe('chat-ana');

      const all = await call(deps, 'todo_promises.list', { state: 'all' }, { identity: bo });
      expect(all.todoPromises!.map((c) => c.what)).toEqual(['Open one', 'Kept one']);
      const limited = await call(deps, 'todo_promises.list', { state: 'all', limit: 1 }, {});
      expect(limited.todoPromises).toHaveLength(1);
      expect(limited.truncated).toBe(true);
      expect(all.truncated).toBe(false);
    });

    it("lets another agent read every agent's list", async () => {
      await call(deps, 'todo_promises.add', { what: 'Ana promise' }, { identity: ana });
      await call(deps, 'todo_promises.add', { what: 'Bo promise' }, { identity: bo });

      const everyone = await call(deps, 'todo_promises.list', {}, { identity: bo });
      expect(everyone.todoPromises!.map((c) => c.what).sort()).toEqual([
        'Ana promise',
        'Bo promise',
      ]);
      const anas = await call(
        deps,
        'todo_promises.list',
        { agentId: 'agent-ana' },
        { identity: bo }
      );
      expect(anas.todoPromises!.map((c) => c.what)).toEqual(['Ana promise']);
    });
  });
});
