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
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../../../lib/logger.js';
import type { MessageSenderOpts } from '../../messaging/message-sender-shared.js';
import type { AgentSession } from '../../agent-types.js';
import { streamTurnWindow } from '../pump-turn-stream.js';
import type { TurnWindow } from '../session-turn-windows.js';

const SESSION_ID = 'sess-pump-stop';

function makeSession(): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: true,
    pendingInteractions: new Map(),
    eventQueue: [],
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

async function runWindow(messages: SDKMessage[]): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of streamTurnWindow({
    sessionId: SESSION_ID,
    session: makeSession(),
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
    const events = await runWindow([stoppedResult()]);

    // Neither the CLI's own frame nor the guard's substitute. This is the whole
    // finding: the operator stopped the turn, the stop was acked, and the
    // durable record used to say the agent crashed.
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    // The turn still ends, and still says it was cut short.
    const status = events.find((e) => e.type === 'session_status');
    expect((status?.data as Record<string, unknown>).terminalReason).toBe('aborted_streaming');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('still calls a genuinely failed empty turn what it is', async () => {
    // The suppression is gated on the abort reason, not on the subtype, so a
    // failure that named no abort keeps its error — otherwise this fix would
    // hide every failed turn on the pump.
    const events = await runWindow([failedResult()]);

    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(deadStreamErrors(events)).toHaveLength(0);
  });
});
