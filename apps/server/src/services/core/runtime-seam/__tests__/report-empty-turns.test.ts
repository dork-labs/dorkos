/**
 * An empty agent reply says so on every runtime (DOR-3606): the seam decorator
 * adds Claude Code's error to a turn that showed nothing, and to no other turn.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import type {
  AgentRuntime,
  DispatchHoldHandshake,
  MessageOpts,
} from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { reportEmptyTurns } from '../report-empty-turns.js';
import { RuntimeRegistry } from '../../runtime-registry.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { TestModeRuntime } from '../../../runtimes/test-mode/test-mode-runtime.js';
import { scenarioStore } from '../../../runtimes/test-mode/scenario-store.js';

/** The words Claude Code has always shown for an empty turn. */
const NO_RESPONSE = 'The agent did not respond. The service may be temporarily unavailable.';

const done: StreamEvent = { type: 'done', data: { sessionId: 's' } };
const completed: StreamEvent = {
  type: 'session_status',
  data: { sessionId: 's', terminalReason: 'completed' },
};
const text = (value: string): StreamEvent => ({ type: 'text_delta', data: { text: value } });

/**
 * A runtime whose one turn yields `events`. `gate`, when given, is awaited
 * before the last event, so a test can act while the turn is open.
 */
function fake(
  events: StreamEvent[],
  options: {
    type?: string;
    gate?: Promise<void>;
    onSend?: (opts: MessageOpts | undefined) => boolean | void;
  } = {}
) {
  const stops: string[] = [];
  const runtime = {
    type: options.type ?? 'codex',
    getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
    async *sendMessage(_id: string, _content: string, opts?: MessageOpts) {
      // A hold ends the stream before anything is yielded.
      if (options.onSend?.(opts) === true) return;
      for (const [index, event] of events.entries()) {
        if (index === events.length - 1 && options.gate) await options.gate;
        yield event;
      }
    },
    async interruptQuery(id: string) {
      stops.push(id);
      return { outcome: 'acked', runtime: 'codex' };
    },
    async endSessionsWhere(belongs: (s: { sessionId: string; cwd: undefined }) => boolean) {
      return belongs({ sessionId: 's', cwd: undefined }) ? ['s'] : [];
    },
  } as unknown as AgentRuntime;
  return { runtime, stops };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const errorsIn = (events: StreamEvent[]) =>
  events.filter((event) => event.type === 'error').map((event) => event.data);

function opened() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

describe('reportEmptyTurns', () => {
  it('an empty turn ends in Claude Code’s error, settled as an error, before its done', async () => {
    const { runtime } = fake([completed, done]);
    const events = await collect(reportEmptyTurns(runtime).sendMessage('s', 'hi'));
    expect(events.map((event) => event.type)).toEqual([
      'session_status',
      'error',
      'session_status',
      'done',
    ]);
    expect(errorsIn(events)).toEqual([{ message: NO_RESPONSE, category: 'execution_error' }]);
    // The last reason wins, so a runtime's own `completed` cannot absolve it.
    expect(events[2]!.data).toEqual({ sessionId: 's', terminalReason: 'error' });
  });

  it('a reply of only whitespace is an empty reply', async () => {
    const { runtime } = fake([text('  '), text('\n\n'), done]);
    const events = await collect(reportEmptyTurns(runtime).sendMessage('s', 'hi'));
    expect(errorsIn(events)).toEqual([{ message: NO_RESPONSE, category: 'execution_error' }]);
  });

  it('a turn with no done still says so, at its end', async () => {
    const { runtime } = fake([completed]);
    const events = await collect(reportEmptyTurns(runtime).sendMessage('s', 'hi'));
    expect(events.map((event) => event.type)).toEqual([
      'session_status',
      'error',
      'session_status',
    ]);
  });

  it.each<[string, StreamEvent[]]>([
    ['a reply', [text('\n'), text('Hello'), done]],
    ['a tool call', [{ type: 'tool_call_start', data: { toolCallId: 't' } } as StreamEvent, done]],
    ['thinking', [{ type: 'thinking_delta', data: { text: 'hm' } } as StreamEvent, done]],
    ['a question for the person', [{ type: 'question_prompt', data: {} } as StreamEvent, done]],
  ])('a turn that showed %s is not empty', async (_name, events) => {
    const { runtime } = fake(events);
    expect(errorsIn(await collect(reportEmptyTurns(runtime).sendMessage('s', 'hi')))).toEqual([]);
  });

  it('a turn that reported its own failure gets no second error (Claude Code’s included)', async () => {
    const own: StreamEvent = { type: 'error', data: { message: NO_RESPONSE } };
    for (const failure of [
      own,
      { type: 'operation_progress', data: { operation: 'compaction', state: 'failed' } },
    ] as StreamEvent[]) {
      const { runtime } = fake([failure, done]);
      const events = await collect(reportEmptyTurns(runtime).sendMessage('s', 'hi'));
      expect(events).toEqual([failure, done]);
    }
  });

  it('a turn stopped through interruptQuery is not empty, though its runtime says nothing', async () => {
    const { gate, open } = opened();
    // Codex's interrupted turn: a bare done, no reason.
    const { runtime, stops } = fake([done], { gate });
    const wrapped = reportEmptyTurns(runtime);
    const reading = collect(wrapped.sendMessage('s', 'hi'));
    await Promise.resolve();
    expect(await wrapped.interruptQuery('s')).toEqual({ outcome: 'acked', runtime: 'codex' });
    expect(stops).toEqual(['s']);
    open();
    expect(await reading).toEqual([done]);
  });

  it('a turn ended by endSessionsWhere is not empty', async () => {
    const { gate, open } = opened();
    const { runtime } = fake([done], { gate });
    const wrapped = reportEmptyTurns(runtime);
    const reading = collect(wrapped.sendMessage('s', 'hi'));
    await Promise.resolve();
    expect(await wrapped.endSessionsWhere(() => true)).toEqual(['s']);
    open();
    expect(await reading).toEqual([done]);
  });

  it('a turn that names an interrupted ending is not empty, unless nobody asked', async () => {
    const stopped: StreamEvent = {
      type: 'session_status',
      data: { sessionId: 's', terminalReason: 'interrupted', stopWasRequested: true },
    };
    const aborted: StreamEvent = {
      type: 'session_status',
      data: { sessionId: 's', terminalReason: 'aborted_streaming' },
    };
    const broke: StreamEvent = {
      type: 'session_status',
      data: { sessionId: 's', terminalReason: 'interrupted', stopWasRequested: false },
    };
    for (const ending of [stopped, aborted]) {
      const { runtime } = fake([ending, done]);
      expect(errorsIn(await collect(reportEmptyTurns(runtime).sendMessage('s', 'hi')))).toEqual([]);
    }
    const { runtime } = fake([broke, done]);
    expect(errorsIn(await collect(reportEmptyTurns(runtime).sendMessage('s', 'hi')))).toHaveLength(
      1
    );
  });

  it('a turn the runtime held back before it started is not empty', async () => {
    const waitingOn: Parameters<DispatchHoldHandshake['hold']>[0] = {
      reason: 'background-work',
      holding: { agents: 1, shells: 0, other: 0 },
      pins: [],
      since: 0,
      releaseAt: 0,
    };
    const { runtime } = fake([done], { onSend: (opts) => opts?.dispatchHold?.hold(waitingOn) });
    let asked = 0;
    const opts: MessageOpts = {
      dispatchHold: {
        proceed: () => undefined,
        hold: () => {
          asked++;
          return true;
        },
      },
    };
    expect(await collect(reportEmptyTurns(runtime).sendMessage('s', 'hi', opts))).toEqual([]);
    expect(asked).toBe(1);
  });

  it('a room turn is left to the room, which says what its silence means', async () => {
    const { runtime } = fake([done]);
    const opts = { roomTurn: { roomId: 'r', authorId: 'a', turnId: 't' } } as MessageOpts;
    expect(await collect(reportEmptyTurns(runtime).sendMessage('s', 'hi', opts))).toEqual([done]);
  });

  it('only the send’s own window counts: later autonomous work is not this reply', async () => {
    const { runtime } = fake([text('Hello'), done, completed, done]);
    const events = await collect(reportEmptyTurns(runtime).sendMessage('s', 'hi'));
    expect(errorsIn(events)).toEqual([]);
  });
});

describe('every registered runtime reports an empty turn', () => {
  // The same list the turn-marks census walks: the built-ins, the test runtime,
  // DorkOS's own, the agent computer bridge, and one registered late.
  it.each([
    'claude-code',
    'codex',
    'opencode',
    'test-mode',
    'doe',
    'computer-local',
    'late-extension',
  ])('%s', async (type) => {
    const registry = new RuntimeRegistry();
    registry.register(fake([completed, done], { type }).runtime);
    const events = await collect(registry.get(type).sendMessage(`${type}-empty`, 'hi'));
    expect(errorsIn(events)).toEqual([{ message: NO_RESPONSE, category: 'execution_error' }]);
  });

  it('a real runtime: test-mode’s turn that compacts instead of answering says so', async () => {
    const registry = new RuntimeRegistry();
    registry.register(new TestModeRuntime());
    scenarioStore.setForSession('compacts', 'compacting');
    scenarioStore.setForSession('echoes', 'simple-text');
    try {
      const empty = await collect(registry.get('test-mode').sendMessage('compacts', 'hi'));
      expect(errorsIn(empty)).toEqual([{ message: NO_RESPONSE, category: 'execution_error' }]);
      const echoed = await collect(registry.get('test-mode').sendMessage('echoes', 'hi'));
      expect(errorsIn(echoed)).toEqual([]);
    } finally {
      scenarioStore.clearSession('compacts');
      scenarioStore.clearSession('echoes');
    }
  });
});
