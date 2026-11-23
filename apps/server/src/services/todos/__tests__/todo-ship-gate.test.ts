/**
 * DOR-5071 ship gate (PM, Nov 23): does a normal to-do flow raise a new card or refusal with
 * to-dos on, compared with the flag off? With the flag off, an agent's to-do is a promise
 * (`todo_promises.add`, classed `local`). With it on, `todos.add` is not in DORKOS_TOOL_READS, so
 * it counts as `outside` and marks the calling turn, and a marked turn is held: a second
 * `todo_add` is refused, and a connected-app send asks first (permission-enforcement).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { noopLogger } from '@dorkos/shared/logger';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { composeRegistry } from '../../core/capabilities/registry.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../core/capabilities/tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../core/capabilities/permission-enforcement.js';
import { ApprovalService } from '../../core/approvals/index.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import { dorkosToolReadOf } from '../../core/capabilities/dorkos-tool-reads.js';
import { turnReadOutsideWords } from '../../core/turn-power/outsider-turn.js';
import { recordTurnLevels } from '../../core/turn-power/turn-levels.js';
import { resetChosenTurns } from '../../core/turn-power/full-autonomy.js';
import { resetLiveOutsiderTurns } from '../../core/turn-power/live-outsider-turns.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { todosDomain } from '../todo-capabilities.js';
import { todoPromisesDomain } from '../todo-promise-capabilities.js';

const AGENT = {
  agentPath: '/agents/wren',
  displayName: 'Wren',
  createdAt: '2026-11-23T12:00:00.000Z',
};
let counter = 0;
const fresh = () => `todo-ship-gate-${(counter += 1)}`;

/** Run one turn in a chat set to Full autonomy, so its level is recorded. */
async function ranAtFull(sessionId: string) {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi')) {
    // drain
  }
}

describe('DOR-5071 ship gate: the to-do flow with to-dos on vs off', () => {
  beforeEach(() => {
    resetChosenTurns();
    resetLiveOutsiderTurns();
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals: new ApprovalService(createTestDb()) });
    initPermissionGate({
      readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => undefined,
    });
  });
  afterEach(() => {
    resetCapabilityTierGate();
    resetPermissionGate();
    resetChosenTurns();
    resetLiveOutsiderTurns();
    vi.restoreAllMocks();
  });

  const todo = { id: 'todo-1' };
  const registry = () =>
    composeRegistry([todosDomain, todoPromisesDomain], {
      logger: noopLogger,
      todoPromiseDeps: {
        service: {
          create: vi.fn(() => todo),
          update: vi.fn(() => todo),
          list: vi.fn(() => []),
          get: vi.fn(() => undefined),
        } as never,
        agentIdForPath: () => 'agent-wren',
      },
      todoDeps: {
        todos: {
          create: vi.fn(() => todo),
          update: vi.fn(() => todo),
          list: vi.fn(() => ({ todos: [] })),
        } as never,
        agentIdForPath: () => 'agent-wren',
        parentOf: () => undefined,
        readSource: () => undefined,
        agentInRoom: () => false,
      },
    });
  const asAgent = (sessionId: string) => ({
    identity: AGENT,
    sessionId,
    mcpServer: 'in-session' as const,
    retryChannel: 'mcp-argument' as const,
  });

  it('classes the flag-gated to-do tools as outside, and the promise tools as local', () => {
    expect(dorkosToolReadOf('todos.add')).toBe('outside');
    expect(dorkosToolReadOf('todos.update')).toBe('outside');
    expect(dorkosToolReadOf('todos.list')).toBe('outside');
    expect(dorkosToolReadOf('todo_promises.add')).toBe('local');
  });

  it('flag off (promises): adding twice and keeping it leaves the turn unmarked', async () => {
    const reg = registry();
    const chat = fresh();
    await ranAtFull(chat);
    await reg.invoke('todo_promises.add', { what: 'Send the made-up quote' }, asAgent(chat));
    await reg.invoke('todo_promises.add', { what: 'Draft the made-up brief' }, asAgent(chat));
    await reg.invoke('todo_promises.update', { id: 'todo-1', state: 'kept' }, asAgent(chat));
    expect(turnReadOutsideWords(chat, AGENT.agentPath)).toBe(false);
  });

  it('flag on (to-dos): one todo_add marks the turn, and a second is refused', async () => {
    const reg = registry();
    const chat = fresh();
    await ranAtFull(chat);
    const first = await reg.invoke(
      'todos.add',
      { what: 'Send the made-up quote', assignee: 'person' },
      asAgent(chat)
    );
    expect(first).toMatchObject({ ok: true });
    expect(turnReadOutsideWords(chat, AGENT.agentPath)).toBe(true);
    const second = await reg.invoke(
      'todos.add',
      { what: 'Draft the made-up brief', assignee: 'person' },
      asAgent(chat)
    );
    expect(second).toMatchObject({ ok: false, code: 'MARKED_TURN' });
    // Marking it kept still works in a marked turn.
    const kept = await reg.invoke('todos.update', { id: 'todo-1', state: 'kept' }, asAgent(chat));
    expect(kept).toMatchObject({ ok: true });
  });
});
