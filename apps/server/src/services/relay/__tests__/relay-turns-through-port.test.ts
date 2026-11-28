/**
 * Relay deliveries start turns through the turn port (spec
 * `turns-survive-restarts` §9 T13, §10 child J; DOR-5220): the adapter the
 * factory builds, the space face, admission, the `start_turn` handler, the
 * computer face, the real launch path, dispatcher and projector, over SQLite.
 * Only the runtime underneath is a double.
 *
 * What this pins: a relay turn has a run record; the relay's handlers never
 * reach the runtime they were handed (every turn reaches the runtime through
 * the dispatcher); a relay turn runs at exactly the power it ran at before the
 * port, sender by sender (the trust-parity proof, F30); and a scheduled run
 * the scheduler handed the relay is a `schedule` run at its task's level.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import {
  ClaudeCodeAdapter,
  type AdapterConfig,
  type AgentRuntimeLike,
  type RelayAdapter,
  type RelayPublisher,
  type TraceStoreLike,
} from '@dorkos/relay';
import { TASK_SCHEDULER_PRINCIPAL, type RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { getRunRecord } from '../../runs/index.js';
import { createAdapter } from '../adapter-factory.js';
import { portTaskTurns } from '../../tasks/execution/task-turns.js';
import {
  portBackedRuntime,
  RelayTurnNotes,
  setRelayTaskRunWords,
} from '../relay-turns/port-runtime.js';
import { installRelayPort, uninstallRelayPort, type RelayPort } from './relay-port-harness.js';

const AGENT_ID = '01JRZ7AGENTRAYP0RT00000000';

/** A turn that says something and ends. */
async function* answer(): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'on it' } } as StreamEvent;
  yield { type: 'done', data: {} } as StreamEvent;
}

/** A runtime the relay is handed and must never drive: a start, a steer or a stop throws. */
function tripwire(): AgentRuntimeLike & Record<string, ReturnType<typeof vi.fn>> {
  const refuse = (what: string) =>
    vi.fn(() => {
      throw new Error(`the relay reached the runtime directly: ${what}`);
    });
  return {
    type: 'claude-code',
    ensureSession: refuse('ensureSession'),
    sendMessage: refuse('sendMessage'),
    interruptQuery: refuse('interruptQuery'),
    approveTool: vi.fn(() => false),
    getSdkSessionId: vi.fn(() => undefined),
  } as unknown as AgentRuntimeLike & Record<string, ReturnType<typeof vi.fn>>;
}

function relayStub(): RelayPublisher & { publish: ReturnType<typeof vi.fn> } {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'r-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as unknown as RelayPublisher & { publish: ReturnType<typeof vi.fn> };
}

const traceStore = (): TraceStoreLike =>
  ({ insertSpan: vi.fn(), updateSpan: vi.fn() }) as unknown as TraceStoreLike;

/** A message to an agent's chat, from `from`, with what the binding router adds. */
function message(chat: string, from: string, payload: Record<string, unknown> = {}): RelayEnvelope {
  return {
    id: `msg-${chat}`,
    subject: `relay.agent.claude-code.${chat}`,
    from,
    replyTo: `relay.inbox.query.${chat}`,
    budget: {
      hopCount: 1,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 300_000,
      callBudgetRemaining: 10,
    },
    createdAt: new Date().toISOString(),
    payload: { content: 'send the weekly update', ...payload },
  } as unknown as RelayEnvelope;
}

/** The fields of a send that decide what the turn may do, as the runtime received them. */
const POWER_FIELDS = [
  'permissionMode',
  'permissionCeiling',
  'carriedMarks',
  'unattendedApprovals',
  'unattended',
  'levelPermissionMode',
  'continuationHold',
  'forAgent',
  'taskApprovedAllow',
] as const;

function powerOf(sent: unknown): Record<string, unknown> {
  const opts = sent as Record<string, unknown>;
  return Object.fromEntries(
    POWER_FIELDS.filter((key) => opts[key] !== undefined).map((key) => [key, opts[key]])
  );
}

let port: RelayPort;
let home: string;
let runtime: FakeAgentRuntime;
let adapters: RelayAdapter[];

beforeEach(async () => {
  port = await installRelayPort();
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-port-agent-')));
  port.standAgent(home, AGENT_ID);
  runtime = new FakeAgentRuntime('claude-code').withScenarios(Array(8).fill(answer));
  runtime.getInternalSessionId.mockReturnValue(undefined);
  runtimeRegistry.register(runtime);
  runtimeRegistry.setDefault('claude-code');
  adapters = [];
});

afterEach(async () => {
  for (const adapter of adapters) await adapter.stop();
  setRelayTaskRunWords(undefined);
  uninstallRelayPort();
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** The built-in adapter as the server builds it, over the runtime the relay is handed. */
async function portAdapter(handed: AgentRuntimeLike): Promise<RelayAdapter> {
  const built = await createAdapter(
    {
      id: 'claude-code',
      type: 'claude-code',
      enabled: true,
      builtin: true,
      config: {},
    } as AdapterConfig,
    {
      agentRuntimes: new Map([['claude-code', handed]]),
      traceStore: traceStore(),
      approvalAuthorizer: () => true,
    },
    '/tmp/adapters.json'
  );
  if (!built) throw new Error('the built-in adapter did not build');
  await built.start(relayStub());
  adapters.push(built);
  return built;
}

/** The adapter as the server built it before T13: the relay drove the registry's runtime itself. */
async function directAdapter(): Promise<RelayAdapter> {
  const driven = runtimeRegistry.get('claude-code') as unknown as AgentRuntimeLike;
  const adapter = new ClaudeCodeAdapter(
    'claude-code-direct',
    {},
    {
      agentManager: driven,
      agentRuntimes: new Map([['claude-code', driven]]),
      traceStore: traceStore(),
      approvalAuthorizer: () => true,
      markStrangerTurns: true,
    }
  );
  await adapter.start(relayStub());
  adapters.push(adapter);
  return adapter;
}

/** Deliver to the agent's chat and return what the runtime's last send carried. */
async function sentThrough(adapter: RelayAdapter, envelope: RelayEnvelope): Promise<unknown> {
  const result = await adapter.deliver(envelope.subject, envelope, {
    agent: { directory: home, runtime: 'claude-code' },
  });
  expect(result, result.error).toMatchObject({ success: true });
  return runtime.sendMessage.mock.calls.at(-1)![2];
}

describe('a relay turn goes through the turn port', () => {
  it('has a run record, and the relay never drives the runtime it was handed', async () => {
    // Purpose: fails if agent-handler.ts reaches a runtime directly, or a relay turn has no run.
    const handed = tripwire();
    const adapter = await portAdapter(handed);
    const chat = '00000000-0000-4000-8000-00000000a113';

    const sent = await sentThrough(
      adapter,
      // As the binding router stamps it: the chat's folder, its agent and the binding's level.
      message(chat, 'relay.human.telegram.bot-example.private-chat', {
        cwd: home,
        forAgent: home,
        __bindingPermissions: { permissionMode: 'acceptEdits' },
      })
    );

    for (const method of ['ensureSession', 'sendMessage', 'interruptQuery']) {
      expect(handed[method], method).not.toHaveBeenCalled();
    }
    expect(runtime.sendMessage).toHaveBeenCalledOnce();
    expect(runtime.sendMessage.mock.calls[0]![1]).toContain('send the weekly update');
    expect(sent).toMatchObject({
      turnStarter: 'telegram',
      forAgent: home,
      cwd: home,
      permissionMode: 'acceptEdits',
    });
    const [run] = port.runsOf(chat);
    expect(run).toMatchObject({
      origin: { kind: 'relay-binding' },
      agentId: AGENT_ID,
      openedBy: 'caller',
      ending: 'completed',
    });
    expect(['ended', 'settled']).toContain(run!.status);
  });

  it('refuses a turn for a folder whose manifest names an agent that lives elsewhere', async () => {
    // Purpose: fails if a copied or edited manifest lets a turn run as another agent.
    const copy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-port-copy-')));
    fs.mkdirSync(path.join(copy, '.dork'));
    fs.copyFileSync(path.join(home, '.dork', 'agent.json'), path.join(copy, '.dork', 'agent.json'));
    const adapter = await portAdapter(tripwire());
    const chat = '00000000-0000-4000-8000-00000000c0c0';

    const result = await adapter.deliver(
      `relay.agent.claude-code.${chat}`,
      message(chat, 'relay.human.telegram.bot-example.private-chat', { forAgent: copy }),
      { agent: { directory: home, runtime: 'claude-code' } }
    );

    fs.rmSync(copy, { recursive: true, force: true });
    expect(result).toMatchObject({
      success: false,
      error: 'This message is for an agent that is not registered, so it was not run.',
    });
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(port.runsOf(chat)).toEqual([]);
  });

  // F30: whatever the direct path gave a relay turn, the port path gives exactly.
  it.each([
    [
      'a bound chat’s stranger, marked, at the binding’s level',
      'relay.human.telegram.bot-example.group-chat',
      { __bindingPermissions: { permissionMode: 'bypassPermissions' }, __untrustedWords: true },
      'relay-binding',
      { permissionMode: 'bypassPermissions', carriedMarks: { outsider: true } },
    ],
    [
      'another agent, held to the runtime’s default',
      'relay.agent.ana.01JRZ7SENDERAGENT000000000',
      { __bindingPermissions: { permissionMode: 'bypassPermissions' } },
      'agent-dm',
      { permissionMode: 'default', permissionCeiling: 'runtime-default' },
    ],
    [
      'a caller from outside, held and marked',
      'relay.external.http',
      {},
      'outside-sender',
      {
        permissionMode: 'default',
        permissionCeiling: 'runtime-default',
        carriedMarks: { outsider: true },
      },
    ],
  ])('runs %s exactly as the direct path did', async (_label, from, payload, origin, held) => {
    // Purpose: fails if the port path runs any relay sender looser (or other) than before.
    const direct = powerOf(
      await sentThrough(
        await directAdapter(),
        message('00000000-0000-4000-8000-00000000d1d1', from, payload)
      )
    );
    const chat = '00000000-0000-4000-8000-00000000b0b0';
    const throughPort = powerOf(
      await sentThrough(await portAdapter(tripwire()), message(chat, from, payload))
    );

    expect(direct).toMatchObject({ ...held, unattendedApprovals: true });
    expect(throughPort).toEqual(direct);
    expect(port.runsOf(chat)[0]).toMatchObject({ origin: { kind: origin } });
  });
});

describe('a scheduled run the scheduler handed the relay', () => {
  it('starts through the port as a schedule run at its task’s level, its words at the scheduler’s source', async () => {
    // Purpose: fails if the relay's task handler reaches a runtime, its run loses its level, or names no task run.
    // The scheduler's door, as startup wires it (DOR-5508).
    setRelayTaskRunWords(portTaskTurns(() => getRunRecord()?.port));
    const handed = tripwire();
    const adapter = await portAdapter(handed);
    const chat = '00000000-0000-4000-8000-0000000074a5';
    const envelope = {
      ...message(chat, TASK_SCHEDULER_PRINCIPAL),
      subject: 'relay.system.tasks.task-morning',
      replyTo: undefined,
      payload: {
        type: 'task_dispatch',
        taskId: 'task-morning',
        runId: '01TASKRUN00000000000000000',
        prompt: 'Sum up the inbox',
        cwd: home,
        forAgent: home,
        permissionMode: 'acceptEdits',
        taskName: 'Morning brief',
        cron: '0 9 * * *',
        trigger: 'scheduled',
        systemPromptAppend: 'TASK SCHEDULER CONTEXT',
        approvedAllow: ['Bash(git status)'],
        sessionId: chat,
        resumeSession: false,
        runtime: 'claude-code',
      },
    } as unknown as RelayEnvelope;

    const result = await adapter.deliver(envelope.subject, envelope);

    expect(result, result.error).toMatchObject({ success: true });
    for (const method of ['ensureSession', 'sendMessage', 'interruptQuery']) {
      expect(handed[method], method).not.toHaveBeenCalled();
    }
    expect(powerOf(runtime.sendMessage.mock.calls.at(-1)![2])).toEqual({
      permissionMode: 'acceptEdits',
      unattendedApprovals: true,
      unattended: true,
      forAgent: home,
      taskApprovedAllow: ['Bash(git status)'],
    });
    expect(port.runsOf(chat)[0]).toMatchObject({
      origin: { kind: 'schedule' },
      agentId: AGENT_ID,
      ending: 'completed',
      sourceRef: 'task-run:01TASKRUN00000000000000000',
    });
  });
});

describe('a send nobody said the sender of', () => {
  it('is refused, never started under a guessed origin', async () => {
    // Purpose: fails if a turn with no sender note runs at all.
    const standIn = portBackedRuntime(tripwire(), 'claude-code', {
      port: () => getRunRecord()!.port,
      notes: new RelayTurnNotes(),
      originOf: () => ({ kind: 'outside-sender' }),
      agentIdOf: async () => undefined,
      chats: { isBound: async () => false, forgetUnstarted: async () => {} },
    });

    const read = async () => {
      for await (const _event of standIn.sendMessage('00000000-0000-4000-8000-00000000e0e0', 'hi'));
    };

    await expect(read()).rejects.toThrow('did not say who sent it');
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(port.runsOf('00000000-0000-4000-8000-00000000e0e0')).toEqual([]);
  });
});
