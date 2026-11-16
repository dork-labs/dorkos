/**
 * DOR-4327: pausing an agent holds the messages queued for it. It used to end
 * the agent's turn, hand the next queued message to a turn the pause refused,
 * delete its row at that turn's start, and never run it.
 *
 * Real dispatcher, projector, SQLite queue, runtime registry (so the real pause
 * backstop wraps the runtime), pause service and boot-rearm path; only the
 * runtime underneath is a double.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, sessionMetadata, type Db } from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AuditActor } from '@dorkos/shared/audit-schemas';
import type { StreamEvent } from '@dorkos/shared/types';

import { runtimeRegistry } from '../../core/runtime-registry.js';
import { setAgentHomeRegistry } from '../../core/agent-identity/agent-home.js';
import {
  resetChatQueueResumeWarnings,
  resumeChatQueue,
} from '../../extensions/agent-send/agent-send-defaults.js';
import {
  AgentPauseService,
  initAgentPause,
  resetAgentPause,
} from '../../mesh/pause/agent-pause.js';
import {
  dispatchMessage,
  isQueuedMessageArmed,
  listQueuedMessages,
  onDispatchLifecycle,
  resetMessageDispatcher,
  setQueuedChatCeilingResolver,
  setQueuedChatHoldResolver,
  type DispatchLifecycleEvent,
} from '../message-dispatcher.js';
import { rearmChatQueues } from '../message-dispatcher/queue-upkeep.js';
import { chatClientId } from '../chat-messages/chat-client-id.js';
import { MessageQueueStore, setMessageQueueStore } from '../message-queue-store.js';
import { disposeProjector, getOrCreateProjector } from '../session-state-projector.js';

/** A made-up agent B, the one being paused. */
const BETA = { id: '01BETAAGENTULID00000000000', home: '/demo/agents/beta' } as const;
const PERSON: AuditActor = { accountId: 'install:demo', kind: 'person', name: 'Owner' };

let db: Db;
let queue: MessageQueueStore;
let inner: FakeAgentRuntime;
let pauses: AgentPauseService;
let sessionId: string;
let releaseLongTurn: (() => void) | undefined;

/** B's running turn: it works until something interrupts it. */
const longTurn = async function* (): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'working' } };
  await new Promise<void>((resolve) => {
    releaseLongTurn = resolve;
  });
  yield { type: 'done', data: {} };
};

const quick = async function* (): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'reply' } };
  yield { type: 'done', data: {} };
};

/** Let every pending microtask and timer-0 callback run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The words the agent's runtime was actually asked to run, in order. */
function ran(): string[] {
  return inner.sendMessage.mock.calls.map((call) => call[1]);
}

/** The server's rearm sweep, as the health tick and a resume run it. */
function rearm(registered: string[] = [BETA.home]): Promise<number> {
  return rearmChatQueues({
    resume: (id) =>
      resumeChatQueue(
        id,
        BETA.home,
        undefined,
        {
          resolveWithRoom: async (request) => ({ cwd: request.cwd ?? BETA.home, rung: 'explicit' }),
        },
        { registeredAgentPaths: () => registered }
      ),
  });
}

/** Agent A's chat queues a message for B while B's turn runs, then B is paused. */
async function queueThenPause(): Promise<string> {
  const runtime = runtimeRegistry.get(inner.type);
  const projector = getOrCreateProjector(sessionId, BETA.home);
  await dispatchMessage({
    sessionId,
    clientId: 'person-window',
    content: 'start the census',
    projector,
    runtime,
    cwd: BETA.home,
  });
  await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(true));
  await dispatchMessage({
    sessionId,
    clientId: chatClientId('chat-alpha'),
    content: 'from A: add the totals',
    projector,
    runtime,
    cwd: BETA.home,
  });
  const [row] = listQueuedMessages(sessionId);
  expect(row?.content).toBe('from A: add the totals');
  await pauses.pause(BETA.id, PERSON, 'demo pause');
  await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
  await settle();
  return row!.id;
}

beforeEach(() => {
  db = createTestDb();
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: BETA.id,
      name: 'beta',
      displayName: 'Beta',
      runtime: 'claude-code',
      projectPath: BETA.home,
      registeredAt: now,
      updatedAt: now,
    })
    .run();
  setAgentHomeRegistry({
    isRegisteredHome: (dir) => dir === BETA.home,
    listRegisteredHomes: () => [BETA.home],
    managedWorkspaceOwner: () => null,
    roomsDir: null,
  });
  pauses = new AgentPauseService({ db, runtimes: () => runtimeRegistry.listRuntimes() });
  initAgentPause(pauses);
  queue = new MessageQueueStore(db);
  setMessageQueueStore(queue);
  inner = new FakeAgentRuntime('pause-holds').withScenarios([longTurn, quick, quick]);
  inner.getInternalSessionId.mockReturnValue(undefined);
  inner.interruptQuery.mockImplementation(async () => {
    releaseLongTurn?.();
    return { outcome: 'acked', runtime: inner.type };
  });
  runtimeRegistry.setDb(db);
  runtimeRegistry.register(inner);
  runtimeRegistry.setDefault(inner.type);
  sessionId = crypto.randomUUID();
  db.insert(sessionMetadata)
    .values({
      sessionId,
      runtime: inner.type,
      agentPath: BETA.home,
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();
  setQueuedChatCeilingResolver(() => 'runtime-default');
  resetChatQueueResumeWarnings();
});

afterEach(async () => {
  releaseLongTurn?.();
  releaseLongTurn = undefined;
  await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
  setQueuedChatCeilingResolver(undefined);
  setQueuedChatHoldResolver(undefined);
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(sessionId);
  resetChatQueueResumeWarnings();
  resetAgentPause();
  setAgentHomeRegistry(undefined);
  vi.restoreAllMocks();
});

describe('pausing an agent holds its queued messages (DOR-4327)', () => {
  it('keeps the queued message when the pause ends the turn ahead of it', async () => {
    const rowId = await queueThenPause();

    // The row survives, and the paused agent never ran it.
    expect(listQueuedMessages(sessionId).map((row) => row.id)).toEqual([rowId]);
    expect(ran()).toEqual(['start the census']);
    // Nothing in this process is about to run it: the resume does that.
    expect(isQueuedMessageArmed(rowId)).toBe(false);
  });

  it('keeps holding it across health-tick sweeps while the agent stays paused', async () => {
    const rowId = await queueThenPause();

    await rearm();
    await rearm();
    await settle();

    expect(listQueuedMessages(sessionId).map((row) => row.id)).toEqual([rowId]);
    expect(ran()).toEqual(['start the census']);
  });

  it('runs it exactly once after the pause is lifted, however often the sweep runs', async () => {
    await queueThenPause();
    // As the server wires it: lifting a pause runs the rearm at once.
    pauses.onResumed(() => void rearm());

    pauses.resume(BETA.id, PERSON);
    await vi.waitFor(() => expect(ran()).toHaveLength(2), { timeout: 2000 });
    await rearm();
    await rearm();
    await vi.waitFor(() => expect(listQueuedMessages(sessionId)).toEqual([]), { timeout: 2000 });
    await settle();

    expect(ran()).toEqual(['start the census', 'from A: add the totals']);
  });

  it('a second resume does not run it twice', async () => {
    await queueThenPause();

    pauses.resume(BETA.id, PERSON);
    await rearm();
    await vi.waitFor(() => expect(listQueuedMessages(sessionId)).toEqual([]), { timeout: 2000 });
    expect(pauses.resume(BETA.id, PERSON).changed).toBe(false);
    await rearm();
    await settle();

    expect(ran()).toEqual(['start the census', 'from A: add the totals']);
  });

  it('holds a message sent to an agent that is already paused and idle', async () => {
    await pauses.pause(BETA.id, PERSON);
    await dispatchMessage({
      sessionId,
      clientId: chatClientId('chat-alpha'),
      content: 'from A: are you there?',
      projector: getOrCreateProjector(sessionId, BETA.home),
      runtime: runtimeRegistry.get(inner.type),
      cwd: BETA.home,
    });
    await settle();

    expect(listQueuedMessages(sessionId).map((row) => row.content)).toEqual([
      'from A: are you there?',
    ]);
    expect(ran()).toEqual([]);
  });

  it.each(['heartbeat', 'todos', 'task:demo', 'extension:flow'])(
    'keeps a person’s held row queued when %s dispatches after resume',
    async (clientId) => {
      inner.withScenarios([quick, quick]);
      const runtime = runtimeRegistry.get(inner.type);
      const projector = getOrCreateProjector(sessionId, BETA.home);
      await pauses.pause(BETA.id, PERSON);
      await dispatchMessage({
        sessionId,
        clientId: 'web-person-window',
        content: 'My held words',
        projector,
        runtime,
        cwd: BETA.home,
      });
      await settle();
      const [held] = listQueuedMessages(sessionId);
      expect(held?.content).toBe('My held words');
      expect(ran()).toEqual([]);

      pauses.onResumed(() => void rearm());
      pauses.resume(BETA.id, PERSON);
      await settle();
      expect(isQueuedMessageArmed(held!.id)).toBe(false);
      await dispatchMessage({
        sessionId,
        clientId,
        content: 'A background check',
        projector,
        runtime,
        cwd: BETA.home,
        unattended: true,
      });
      await vi.waitFor(() => expect(ran()).toContain('A background check'));
      await settle();
      expect(ran()).not.toContain('My held words');
      expect(listQueuedMessages(sessionId).map((row) => row.id)).toEqual([held!.id]);
      expect(isQueuedMessageArmed(held!.id)).toBe(false);
    }
  );

  it('holds it when the pause lands while its launch is under way', async () => {
    await pauses.pause(BETA.id, PERSON);
    // The launch's own check runs a beat before the pause is in force; the
    // pause backstop at the runtime seam still refuses the turn it opens.
    const real = pauses.pausedAgentOfSession.bind(pauses);
    vi.spyOn(pauses, 'pausedAgentOfSession')
      .mockImplementationOnce(() => undefined)
      .mockImplementation(real);
    await dispatchMessage({
      sessionId,
      clientId: chatClientId('chat-alpha'),
      content: 'from A: mid-launch',
      projector: getOrCreateProjector(sessionId, BETA.home),
      runtime: runtimeRegistry.get(inner.type),
      cwd: BETA.home,
    });
    await settle();

    const [row] = listQueuedMessages(sessionId);
    expect(row?.content).toBe('from A: mid-launch');
    expect(ran()).toEqual([]);
    expect(isQueuedMessageArmed(row!.id)).toBe(false);

    pauses.resume(BETA.id, PERSON);
    await rearm();
    await vi.waitFor(() => expect(listQueuedMessages(sessionId)).toEqual([]), { timeout: 2000 });
    expect(ran()).toEqual(['from A: mid-launch']);
  });

  it('keeps it held when the agent is unregistered while paused', async () => {
    const rowId = await queueThenPause();

    // Unregistering drops the pause with the agent (agent-pause `forget`).
    pauses.forget(BETA.id);
    await rearm([]);
    await rearm([]);
    await settle();

    expect(listQueuedMessages(sessionId).map((row) => row.id)).toEqual([rowId]);
    expect(ran()).toEqual(['start the census']);
  });

  it('runs a person’s own queued message only when they send, not on resume', async () => {
    inner.withScenarios([longTurn, quick, quick, quick]);
    const runtime = runtimeRegistry.get(inner.type);
    const projector = getOrCreateProjector(sessionId, BETA.home);
    await dispatchMessage({
      sessionId,
      clientId: 'person-window',
      content: 'start the census',
      projector,
      runtime,
      cwd: BETA.home,
    });
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(true));
    for (const [clientId, content] of [
      ['person-window', 'person: one more thing'],
      [chatClientId('chat-alpha'), 'from A: add the totals'],
    ] as const) {
      await dispatchMessage({ sessionId, clientId, content, projector, runtime, cwd: BETA.home });
    }
    await pauses.pause(BETA.id, PERSON);
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
    await settle();

    pauses.resume(BETA.id, PERSON);
    await rearm();
    await vi.waitFor(() => expect(ran()).toHaveLength(2), { timeout: 2000 });
    await rearm();
    await settle();

    // The other chat's message ran; the person's waits in their composer.
    expect(ran()).toEqual(['start the census', 'from A: add the totals']);
    expect(listQueuedMessages(sessionId).map((row) => row.content)).toEqual([
      'person: one more thing',
    ]);

    // A new message from another chat cannot press Send for the person.
    await dispatchMessage({
      sessionId,
      clientId: chatClientId('chat-gamma'),
      content: 'from C: check the totals',
      projector,
      runtime,
      cwd: BETA.home,
    });
    await settle();
    expect(ran()).toEqual([
      'start the census',
      'from A: add the totals',
      'from C: check the totals',
    ]);
    expect(listQueuedMessages(sessionId).map((row) => row.content)).toEqual([
      'person: one more thing',
    ]);

    // Pressing send runs it, then what they just sent.
    await dispatchMessage({
      sessionId,
      clientId: 'person-window',
      content: 'person: and this',
      projector,
      runtime,
      cwd: BETA.home,
    });
    await vi.waitFor(() => expect(listQueuedMessages(sessionId)).toEqual([]), { timeout: 2000 });
    await vi.waitFor(() => expect(ran()).toHaveLength(5), { timeout: 2000 });
    expect(ran().slice(3).sort()).toEqual(['person: and this', 'person: one more thing']);
  });
});

describe('a pause between a queued turn’s start and its first model request (DOR-4353)', () => {
  /** Set while the cut turn waits at its first model request. */
  let atModelRequest: (() => void) | undefined;
  /** Which words each scenario answered, in order: what the agent really read. */
  let answered: string[];

  /**
   * The queued message's turn: started (its `turn_start` is out, its row is
   * off the queue), then held at the model request until something interrupts.
   */
  const stallsBeforeModel = async function* (content: string): AsyncGenerator<StreamEvent> {
    await new Promise<void>((resolve) => {
      atModelRequest = resolve;
    });
    yield { type: 'text_delta', data: { text: 'too late' } };
    // Only reached when the hold passed that output on, so the agent spoke.
    answered.push(content);
    yield { type: 'done', data: {} };
  };

  const answers = async function* (content: string): AsyncGenerator<StreamEvent> {
    answered.push(content);
    yield { type: 'text_delta', data: { text: 'reply' } };
    yield { type: 'done', data: {} };
  };

  beforeEach(() => {
    answered = [];
    atModelRequest = undefined;
    inner.withScenarios([longTurn, stallsBeforeModel, answers, answers]);
    inner.interruptQuery.mockImplementation(async () => {
      releaseLongTurn?.();
      atModelRequest?.();
      return { outcome: 'acked', runtime: inner.type };
    });
  });

  /**
   * B runs a turn while A's message waits; the turn ends, A's message starts,
   * and B is paused before its model request is made. Returns the row's id.
   */
  async function startThenPauseBeforeModel(events: DispatchLifecycleEvent[] = []): Promise<string> {
    const stop = onDispatchLifecycle((event) => events.push(event));
    const runtime = runtimeRegistry.get(inner.type);
    const projector = getOrCreateProjector(sessionId, BETA.home);
    await dispatchMessage({
      sessionId,
      clientId: 'person-window',
      content: 'start the census',
      projector,
      runtime,
      cwd: BETA.home,
    });
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(true));
    await dispatchMessage({
      sessionId,
      clientId: chatClientId('chat-alpha'),
      content: 'from A: add the totals',
      projector,
      runtime,
      cwd: BETA.home,
    });
    const [row] = listQueuedMessages(sessionId);
    expect(row?.content).toBe('from A: add the totals');

    // The turn ahead ends; A's message starts and waits at its model request.
    releaseLongTurn?.();
    await vi.waitFor(() => expect(atModelRequest).toBeDefined(), { timeout: 2000 });
    // Pinned: its turn_start is out and its row is off the queue.
    expect(events).toContainEqual({ phase: 'started', messageId: row!.id, sessionId });
    expect(listQueuedMessages(sessionId)).toEqual([]);

    await pauses.pause(BETA.id, PERSON, 'demo pause');
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
    await settle();
    stop();
    return row!.id;
  }

  it('holds the row, then runs it exactly once on resume', async () => {
    const rowId = await startThenPauseBeforeModel();

    // Held: back on the queue, unread, and nothing here is about to run it.
    expect(listQueuedMessages(sessionId).map((row) => row.id)).toEqual([rowId]);
    expect(answered).toEqual([]);
    expect(isQueuedMessageArmed(rowId)).toBe(false);
    await rearm();
    await settle();
    expect(answered).toEqual([]);

    pauses.onResumed(() => void rearm());
    pauses.resume(BETA.id, PERSON);
    await vi.waitFor(() => expect(answered).toEqual(['from A: add the totals']), {
      timeout: 2000,
    });
    await vi.waitFor(() => expect(listQueuedMessages(sessionId)).toEqual([]), { timeout: 2000 });
    await rearm();
    await rearm();
    await settle();

    expect(answered).toEqual(['from A: add the totals']);
  });

  it('never reruns a turn the agent had already started answering', async () => {
    const answersThenWaits = async function* (content: string): AsyncGenerator<StreamEvent> {
      answered.push(content);
      yield { type: 'text_delta', data: { text: 'halfway' } };
      await new Promise<void>((resolve) => {
        atModelRequest = resolve;
      });
      yield { type: 'done', data: {} };
    };
    inner.withScenarios([longTurn, answersThenWaits, answers]);
    const events: DispatchLifecycleEvent[] = [];
    const stop = onDispatchLifecycle((event) => events.push(event));
    const runtime = runtimeRegistry.get(inner.type);
    const projector = getOrCreateProjector(sessionId, BETA.home);
    await dispatchMessage({
      sessionId,
      clientId: 'person-window',
      content: 'start the census',
      projector,
      runtime,
      cwd: BETA.home,
    });
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(true));
    await dispatchMessage({
      sessionId,
      clientId: chatClientId('chat-alpha'),
      content: 'from A: add the totals',
      projector,
      runtime,
      cwd: BETA.home,
    });
    releaseLongTurn?.();
    await vi.waitFor(() => expect(atModelRequest).toBeDefined(), { timeout: 2000 });

    await pauses.pause(BETA.id, PERSON);
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
    await settle();
    pauses.resume(BETA.id, PERSON);
    await rearm();
    await settle();
    stop();

    // It ran once, as far as it got; the pause stops it like any running turn.
    expect(listQueuedMessages(sessionId)).toEqual([]);
    expect(answered).toEqual(['from A: add the totals']);
    expect(events.map((event) => event.phase)).not.toContain('held');
  });

  /**
   * A's message starts with `cut` as its turn, which shows `shown` and then
   * waits until interrupted; B is paused there and resumed. Returns how many
   * times B's runtime was asked to run A's words, and the options of each.
   */
  async function cutPauseResume(
    shown: StreamEvent[],
    extra: Partial<Parameters<typeof dispatchMessage>[0]> = {}
  ): Promise<{ runs: number; opts: Array<Record<string, unknown>> }> {
    const cut = async function* (): AsyncGenerator<StreamEvent> {
      for (const event of shown) yield event;
      await new Promise<void>((resolve) => {
        atModelRequest = resolve;
      });
      yield { type: 'done', data: {} };
    };
    inner.withScenarios([longTurn, cut, answers, answers]);
    const runtime = runtimeRegistry.get(inner.type);
    const projector = getOrCreateProjector(sessionId, BETA.home);
    await dispatchMessage({
      sessionId,
      clientId: 'person-window',
      content: 'start the census',
      projector,
      runtime,
      cwd: BETA.home,
    });
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(true));
    await dispatchMessage({
      sessionId,
      clientId: chatClientId('chat-alpha'),
      content: 'from A: add the totals',
      projector,
      runtime,
      cwd: BETA.home,
      ...extra,
    });
    releaseLongTurn?.();
    await vi.waitFor(() => expect(atModelRequest).toBeDefined(), { timeout: 2000 });
    const stopped = vi.spyOn(pauses, 'stopSession');
    await pauses.pause(BETA.id, PERSON);
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
    await settle();
    // Cut by the pause backstop's thrown AgentPausedError, as QA saw live:
    // `stopSession` runs only on that path.
    expect(stopped).toHaveBeenCalled();
    // A different caller lifts the pause: its limits must not reach the run.
    pauses.resume(BETA.id, {
      accountId: '01ALPHAAGENTULID0000000000',
      kind: 'agent',
      name: 'alpha',
    });
    await rearm();
    await settle();
    await settle();
    const calls = inner.sendMessage.mock.calls.filter(
      (call) => call[1] === 'from A: add the totals'
    );
    return {
      runs: calls.length,
      opts: calls.map((call) => (call[2] ?? {}) as Record<string, unknown>),
    };
  }

  it('never reruns a turn whose tool call had started (Security Must 1)', async () => {
    const { runs } = await cutPauseResume([
      { type: 'tool_call_start', data: { toolCallId: 'call-1', toolName: 'Bash', input: '' } },
    ] as StreamEvent[]);
    expect(runs).toBe(1);
    expect(listQueuedMessages(sessionId)).toEqual([]);
  });

  it('never reruns a turn that raised a card (Security Must 1)', async () => {
    const { runs } = await cutPauseResume([
      {
        type: 'approval_required',
        data: { toolCallId: 'call-1', toolName: 'Bash', input: '{}', timeoutMs: 60_000 },
      },
    ] as unknown as StreamEvent[]);
    expect(runs).toBe(1);
    expect(listQueuedMessages(sessionId)).toEqual([]);
  });

  it('still reruns a turn that only made its model request (the PM’s ruling: a repeat beats a loss)', async () => {
    const { runs } = await cutPauseResume([
      { type: 'model_request', data: { requestId: 'r-1', phase: 'start', startedAt: 1 } },
    ] as unknown as StreamEvent[]);
    expect(runs).toBe(2);
    expect(answered).toEqual(['from A: add the totals']);
  });

  it('keeps the author and every mark on the rerun, never the resumer’s (Security Must 2)', async () => {
    // A Wi-Fi hold (held to the default) and a chat-recorded outsider mark. No
    // chat ceiling, so the default level can only come from the row's own hold.
    setQueuedChatCeilingResolver(undefined);
    setQueuedChatHoldResolver(() => true);
    const { runs, opts } = await cutPauseResume([], { permissionCeiling: 'runtime-default' });
    setQueuedChatHoldResolver(undefined);

    expect(runs).toBe(2);
    // Sent under a fresh runtime id, and still marked: the marks are keyed to the row's id.
    expect(opts[1]!.messageId).not.toBe(opts[0]!.messageId);
    const rerun = opts[1]!;
    expect((rerun.carriedMarks as { outsider?: boolean } | undefined)?.outsider).toBe(true);
    expect(boundsOf(rerun.permissionCeiling)).toContain('runtime-default');
    const asked = inner.sendMessage.mock.calls.at(-1);
    expect(asked?.[1]).toBe('from A: add the totals');
  });

  it('a mark that lived only in memory is held to the default on the rerun (Security Must 2)', async () => {
    setQueuedChatCeilingResolver(undefined);
    const { runs, opts } = await cutPauseResume([], { carriedMarks: { outsider: true } });

    expect(runs).toBe(2);
    expect(boundsOf(opts[1]!.permissionCeiling)).toContain('runtime-default');
  });

  /**
   * What a real Claude Code turn showed before its first model request in
   * QA's 0.135.11 gate (W5, W6): its session state, and the next-prompt
   * suggestion carried over from the previous turn. None of it is the agent
   * acting; the suggestion made every queued turn read as acted, so the
   * pause backstop's thrown `AgentPausedError` lost the message.
   */
  const LAUNCH_EVENTS = [
    { type: 'system_status', data: { message: 'Starting.' } },
    { type: 'session_status', data: { sessionId: 'x', model: 'claude-made-up' } },
    { type: 'session_state_changed', data: { state: 'running' } },
    { type: 'prompt_suggestion', data: { suggestion: 'Add the totals' } },
    { type: 'session_state_changed', data: { state: 'running' } },
  ] as unknown as StreamEvent[];

  it('reruns a turn the pause cut after its launch events, with no model request (QA W5)', async () => {
    const { runs } = await cutPauseResume(LAUNCH_EVENTS);
    expect(runs).toBe(2);
    expect(answered).toEqual(['from A: add the totals']);
  });

  it('reruns a turn the pause cut after one model request with no output (QA W6)', async () => {
    const { runs } = await cutPauseResume([
      ...LAUNCH_EVENTS,
      { type: 'model_request', data: { requestId: 'r-1', phase: 'start', startedAt: 1 } },
    ] as unknown as StreamEvent[]);
    expect(runs).toBe(2);
    expect(answered).toEqual(['from A: add the totals']);
  });

  it('reruns under a fresh runtime message id, the row keeping its own (QA W1)', async () => {
    // A cut turn's message can already be in the runtime's transcript under the id it was sent
    // with, and Claude Code runs nothing for an id it already holds: the rerun never started.
    const started: string[] = [];
    const stop = onDispatchLifecycle((event) => {
      if (event.phase === 'started') started.push(event.messageId);
    });
    const { runs, opts } = await cutPauseResume(LAUNCH_EVENTS);
    stop();

    expect(runs).toBe(2);
    expect(answered).toEqual(['from A: add the totals']);
    // The same queue row both times, so its chat record and marks still match it ...
    expect(started.slice(-2)).toEqual([opts[0]!.messageId, opts[0]!.messageId]);
    // ... sent to the runtime under a new id the second time.
    expect(opts[1]!.messageId).toEqual(expect.any(String));
    expect(opts[1]!.messageId).not.toBe(opts[0]!.messageId);
  });

  it('tells the sender it is held, not that it failed or ran', async () => {
    const events: DispatchLifecycleEvent[] = [];
    const rowId = await startThenPauseBeforeModel(events);

    const mine = events.filter((event) => event.messageId === rowId);
    expect(mine.map((event) => event.phase)).toEqual(['started', 'held']);
    expect(mine.at(-1)).toEqual({ phase: 'held', messageId: rowId, sessionId });
  });
});

/** The bounds a turn's ceiling names, however it was written. */
function boundsOf(ceiling: unknown): unknown[] {
  if (ceiling === undefined) return [];
  return Array.isArray(ceiling) ? ceiling : [ceiling];
}

/** The options the runtime got for each turn, in order. */
function optsRan(): Array<Record<string, unknown>> {
  return inner.sendMessage.mock.calls.map((call) => (call[2] ?? {}) as Record<string, unknown>);
}

describe('a held message never loses the limits its plan carried (DOR-4327, Security M1)', () => {
  /**
   * Agent A posts over HTTP from a marked turn, under a chat-shaped client id so
   * the rearm picks it up. Its mark and bound live in the plan only. Then B is
   * paused and resumed by an agent.
   */
  async function queueMarkedThenPauseResume(
    extra: Partial<Parameters<typeof dispatchMessage>[0]>
  ): Promise<void> {
    // A spoofed chat id has no chat message record, so no ceiling comes from there.
    setQueuedChatCeilingResolver(undefined);
    const runtime = runtimeRegistry.get(inner.type);
    const projector = getOrCreateProjector(sessionId, BETA.home);
    await dispatchMessage({
      sessionId,
      clientId: 'person-window',
      content: 'start',
      projector,
      runtime,
      cwd: BETA.home,
    });
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(true));
    await dispatchMessage({
      sessionId,
      clientId: 'chat:spoofed-by-agent-a',
      content: 'marked words',
      projector,
      runtime,
      cwd: BETA.home,
      ...extra,
    });
    await pauses.pause(BETA.id, PERSON);
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
    await settle();
    pauses.onResumed(() => void rearm());
    pauses.resume(BETA.id, {
      accountId: '01ALPHAAGENTULID0000000000',
      kind: 'agent',
      name: 'alpha',
    });
    await settle();
    await settle();
  }

  /** It ran with its mark and a bound, or at the default level, or not at all. */
  function expectNoRaise(): void {
    const index = ran().indexOf('marked words');
    if (index === -1) return;
    const opts = optsRan()[index]!;
    const keptMark =
      (opts.carriedMarks as { outsider?: boolean } | undefined)?.outsider === true &&
      opts.permissionCeiling !== undefined;
    expect(keptMark || boundsOf(opts.permissionCeiling).includes('runtime-default')).toBe(true);
  }

  it('an outsider mark and a bound', async () => {
    await queueMarkedThenPauseResume({
      carriedMarks: { outsider: true },
      // A loose teammate-chain bound, as `launcherTurnCeiling` passes in the plan only.
      permissionCeiling: { asks: 'never', reach: 'everything' },
    });
    expect(ran()).toContain('marked words');
    expectNoRaise();
  });

  it('an unattended turn, as a heartbeat queues', async () => {
    await queueMarkedThenPauseResume({ unattended: true });
    expect(ran()).toContain('marked words');
    expectNoRaise();
  });
});
