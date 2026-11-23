/**
 * DOR-5071 ship gate (PM, Nov 23): does a normal to-do flow raise a new card or refusal with
 * to-dos on, compared with the flag off? With the flag off, an agent's to-do is a promise
 * (`todo_promises.*`). With it on, it is a to-do (`todos.*`). Both flows here (add, mark kept, add
 * again, then a connected-app send) must end the same way: the turn unmarked, no refusal, and the
 * send going through with no approval card. It tripped before DOR-4666, when every `todos.*` call
 * marked the turn.
 *
 * Driven through the real to-do and promise services and stores, the real registry, and the real
 * permission gate. The send is a stand-in under the real `connectors.execute_write` id, so the real
 * marked-turn hold decides whether it asks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { noopLogger } from '@dorkos/shared/logger';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { createTestDb } from '@dorkos/test-utils/db';
import { ApprovalService } from '../../core/approvals/index.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import { defineCapability, type CapabilityDeps } from '../../core/capabilities/index.js';
import { composeRegistry, type CapabilityRegistry } from '../../core/capabilities/registry.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../core/capabilities/tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../core/capabilities/permission-enforcement.js';
import { turnReadOutsideWords } from '../../core/turn-power/outsider-turn.js';
import { recordTurnLevels } from '../../core/turn-power/turn-levels.js';
import { resetChosenTurns } from '../../core/turn-power/full-autonomy.js';
import { resetLiveOutsiderTurns } from '../../core/turn-power/live-outsider-turns.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { TodoPromiseService } from '../todo-promise-service.js';
import { TodoPromiseStore } from '../todo-promise-store.js';
import { rowCarriesOutsideWords } from '../todo-authority.js';
import { TodoService } from '../todo-service.js';
import { TodoStore } from '../todo-store.js';
import { todosDomain } from '../todo-capabilities.js';
import { todoPromisesDomain } from '../todo-promise-capabilities.js';

const WREN = {
  agentPath: '/agents/wren',
  displayName: 'Wren',
  createdAt: '2026-11-23T12:00:00.000Z',
};
const BO = { agentPath: '/agents/bo', displayName: 'Bo', createdAt: '2026-11-23T12:00:00.000Z' };
const IDS: Record<string, string> = { '/agents/wren': 'agent-wren', '/agents/bo': 'agent-bo' };
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

/** A send in an outside account, under the real id, so the real marked-turn hold decides. */
const send = defineCapability({
  id: 'connectors.execute_write',
  title: 'Send',
  description: 'A stand-in send, under the real id.',
  tier: 'act',
  area: null,
  approvalDisplayFields: ['to'],
  input: z.object({ to: z.string() }),
  output: z.unknown(),
  surfaces: { mcp: { toolName: 'probe_send', servers: ['in-session'] } },
  invoke: async () => ({ sent: true }),
});

/** What a flow ended with: whether the turn was marked, any refusal, and what the send returned. */
interface Outcome {
  marked: boolean;
  refused: string[];
  send: unknown;
}

describe('DOR-5071 ship gate: the to-do flow with to-dos on matches the flag off', () => {
  let registry: CapabilityRegistry;
  let promises: TodoPromiseService;

  beforeEach(() => {
    resetChosenTurns();
    resetLiveOutsiderTurns();
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    const db = createTestDb();
    initCapabilityTierGate({ approvals: new ApprovalService(db) });
    initPermissionGate({
      readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => undefined,
    });
    promises = new TodoPromiseService({ store: new TodoPromiseStore(db) });
    const store = new TodoStore(db);
    const todos = new TodoService({
      store,
      agentExists: (id) => Object.values(IDS).includes(id),
      mayAssign: () => true,
      rearm: () => {},
      onTurnable: () => {},
    });
    const carriesOutsideWords = (id: string) => rowCarriesOutsideWords(store.get(id));
    const deps = {
      logger: noopLogger,
      todoPromiseDeps: {
        service: promises,
        agentIdForPath: (path: string) => IDS[path],
        carriesOutsideWords,
      },
      todoDeps: {
        todos,
        agentIdForPath: (path: string) => IDS[path],
        parentOf: () => undefined,
        readSource: () => undefined,
        agentInRoom: () => true,
        carriesOutsideWords,
      },
    } as unknown as CapabilityDeps;
    registry = composeRegistry(
      [todosDomain, todoPromisesDomain, { name: 'connectors', capabilities: [send] }],
      deps
    );
  });

  afterEach(() => {
    promises.stop();
    resetCapabilityTierGate();
    resetPermissionGate();
    resetChosenTurns();
    resetLiveOutsiderTurns();
    vi.restoreAllMocks();
  });

  /** Call as Wren (or `who`) in `chat`; a refusal records its code and returns the gate's payload. */
  async function call(id: string, input: unknown, chat: string, refused: string[], who = WREN) {
    let result: Record<string, unknown>;
    try {
      result = (await registry.invoke(id, input, {
        identity: who,
        sessionId: chat,
        mcpServer: 'in-session',
        retryChannel: 'mcp-argument',
      })) as Record<string, unknown>;
    } catch (err) {
      const decision = (err as { decision?: { payload: Record<string, unknown> } }).decision;
      if (!decision) throw err;
      result = decision.payload;
    }
    if (result.ok === false) refused.push(`${id}: ${String(result.code)}`);
    return result;
  }

  /**
   * The send, after the to-do calls. The mark is read just before it: a connected-app call marks
   * the turn itself once it has run, which is not what the gate is about.
   */
  async function sendAfter(chat: string, refused: string[]): Promise<Outcome> {
    const marked = turnReadOutsideWords(chat, WREN.agentPath);
    const sent = await call('connectors.execute_write', { to: 'pat@example.invalid' }, chat, []);
    return { marked, refused, send: sent };
  }

  /** Flag off: the agent's to-dos are its own promises. */
  async function flagOff(): Promise<Outcome> {
    const chat = fresh();
    const refused: string[] = [];
    await ranAtFull(chat);
    const first = await call(
      'todo_promises.add',
      { what: 'Send the made-up quote' },
      chat,
      refused
    );
    const id = (first as { todoPromise: { id: string } }).todoPromise.id;
    await call('todo_promises.update', { id, state: 'kept', note: 'Sent.' }, chat, refused);
    await call('todo_promises.add', { what: 'Draft the made-up brief' }, chat, refused);
    await call('todo_promises.list', {}, chat, refused);
    return sendAfter(chat, refused);
  }

  /**
   * Flag on: a teammate hands the agent a to-do from its own clean turn; the agent reads its list,
   * keeps it, hands two more on, and sends. (A to-do an agent gives itself is a promise, and is kept
   * as one, as with the flag off.)
   */
  async function flagOn(): Promise<Outcome> {
    const bosChat = fresh();
    await ranAtFull(bosChat);
    const given = await call(
      'todos.add',
      { what: 'Send the made-up quote', assignee: 'agent-wren' },
      bosChat,
      [],
      BO
    );
    const id = (given as { todo: { id: string } }).todo.id;
    const chat = fresh();
    const refused: string[] = [];
    await ranAtFull(chat);
    await call('todos.list', {}, chat, refused);
    await call('todos.update', { id, state: 'kept', note: 'Sent.' }, chat, refused);
    await call(
      'todos.add',
      { what: 'Draft the made-up brief', assignee: 'agent-bo' },
      chat,
      refused
    );
    await call('todos.add', { what: 'Book the made-up venue', assignee: 'person' }, chat, refused);
    return sendAfter(chat, refused);
  }

  it('flag off (promises): add, keep, add again and a send raise no card and no refusal', async () => {
    expect(await flagOff()).toEqual({ marked: false, refused: [], send: { sent: true } });
  });

  it('flag on (to-dos): the same flow raises no card and no refusal', async () => {
    expect(await flagOn()).toEqual({ marked: false, refused: [], send: { sent: true } });
  });

  it('flag on ends exactly as flag off does', async () => {
    expect(await flagOn()).toEqual(await flagOff());
  });
});
