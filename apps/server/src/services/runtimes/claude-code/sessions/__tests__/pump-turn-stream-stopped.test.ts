/**
 * A Stop on the persistent pump, from the raw `result` the CLI sends to the
 * events a person ends up looking at (DOR-1320).
 *
 * The production mapper runs here, unmocked, because the whole question is what
 * `mapSdkMessage` makes of a `result` whose subtype is an error and whose
 * terminal reason says the turn was cut short — the shape every observed Stop
 * on this path produced. Two things have to be true of that turn: it carries no
 * `error` frame, and it is not additionally reported as a dead stream.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../../../lib/logger.js';
import type { MessageSenderOpts } from '../../messaging/message-sender-shared.js';
import type { AgentSession } from '../../agent-types.js';
import { streamTurnWindow } from '../pump-turn-stream.js';
import type { TurnWindow } from '../session-turn-windows.js';

const SESSION_ID = 'sess-pump-stop';

/** The pump's live query — one object serving every turn on a warm process. */
const PUMP_QUERY = {} as Query;

/**
 * A session mid-turn on the pump. `stopped` stages the record
 * `interruptGivenQuery` writes when a person presses Stop, which is the INTENT
 * half of the gate on a stopped turn's error frame.
 */
function makeSession(stopped: boolean): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: true,
    pendingInteractions: new Map(),
    eventQueue: [],
    // The pump arms this on its `running` edge; a turn is in flight here.
    activeQuery: PUMP_QUERY,
    ...(stopped ? { stoppedQueries: new WeakSet<Query>([PUMP_QUERY]) } : {}),
  };
}

function makeOpts(): MessageSenderOpts {
  return { cwd: '/mock/project', onSdkSessionRebind: async () => {} };
}

/**
 * The `result` the CLI sends after it acks an interrupt: an error subtype, its
 * own `[ede_diagnostic]` text, and a terminal reason naming the abort.
 */
function stoppedResult(): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    terminal_reason: 'aborted_streaming',
    errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
    uuid: 'result-stopped',
    session_id: 'sdk-1',
  } as unknown as SDKMessage;
}

/** The same result without the abort reason — a turn that genuinely failed. */
function failedResult(): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['Tool run_command exited with code 1'],
    uuid: 'result-failed',
    session_id: 'sdk-1',
  } as unknown as SDKMessage;
}

function makeWindow(messages: SDKMessage[]): TurnWindow {
  return {
    ids: ['msg-1'],
    origin: 'user',
    messages: {
      [Symbol.asyncIterator]: async function* () {
        for (const message of messages) yield message;
      },
    },
  };
}

async function runWindow(messages: SDKMessage[], stopped: boolean): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of streamTurnWindow({
    sessionId: SESSION_ID,
    session: makeSession(stopped),
    window: makeWindow(messages),
    opts: makeOpts(),
    meshAgentId: undefined,
  })) {
    events.push(event);
  }
  return events;
}

/** The "The agent did not respond" line the empty-stream guard adds. */
function deadStreamErrors(events: StreamEvent[]): StreamEvent[] {
  return events.filter(
    (e) =>
      e.type === 'error' &&
      String((e.data as { message?: string }).message ?? '').includes('did not respond')
  );
}

beforeEach(() => {
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('streamTurnWindow — a Stop the CLI acked (DOR-1320)', () => {
  it('records no error at all for a turn a person stopped', async () => {
    const events = await runWindow([stoppedResult()], true);

    // Neither the CLI's own frame nor the guard's substitute. This is the whole
    // finding: the operator stopped the turn, the stop was acked, and the
    // durable record used to say the agent crashed.
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    // The turn still ends, and still says it was cut short.
    const status = events.find((e) => e.type === 'session_status');
    expect((status?.data as Record<string, unknown>).terminalReason).toBe('aborted_streaming');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('KEEPS the error when the same abort shape arrived with no Stop behind it', async () => {
    // Identical `result`, no stop record — the `refusal-fallback-edit` shape,
    // where the CLI aborts the main turn controller itself. Suppressing here
    // would hide a real failure and tell the operator they stopped a turn they
    // never touched (DOR-1320 review, SF1).
    const events = await runWindow([stoppedResult()], false);

    expect(events.some((e) => e.type === 'error')).toBe(true);
    // And with the error reported, the guard must not pile its vaguer line on.
    expect(deadStreamErrors(events)).toHaveLength(0);
  });

  it('still calls a genuinely failed empty turn what it is', async () => {
    // A stop WAS requested, but this result named no abort at all — so the
    // conjunct's shape half fails and the failure keeps its error frame.
    const events = await runWindow([failedResult()], true);

    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(deadStreamErrors(events)).toHaveLength(0);
  });

  it('does not call a stopped, wordless turn a dead stream', async () => {
    // Stop pressed before the agent said anything: zero content, and now no
    // error frame either. Without the guard knowing about the stop, the turn
    // gets "The agent did not respond" — a crash notice for something the
    // operator did on purpose (DOR-1244, fixed on the resume path first).
    const events = await runWindow([stoppedResult()], true);

    expect(deadStreamErrors(events)).toHaveLength(0);
  });
});
