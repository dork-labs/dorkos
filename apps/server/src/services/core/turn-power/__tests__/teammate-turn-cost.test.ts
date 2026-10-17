/**
 * What each turn a teammate started cost reaches the space's monthly counter (DOR-2956): only a
 * teammate's turn, however it ends, with the runtime's own reported turn cost or none.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { meterTeammateTurns, setTeammateTurnCostSink } from '../teammate-turn-cost.js';

function runtime(events: StreamEvent[], type = 'claude-code'): AgentRuntime {
  return {
    type,
    async *sendMessage() {
      for (const event of events) yield event;
    },
  } as unknown as AgentRuntime;
}

const status = (data: Record<string, unknown>) =>
  ({ type: 'session_status', data }) as unknown as StreamEvent;
const done = { type: 'done', data: {} } as unknown as StreamEvent;

const teammate: MessageOpts = {
  roomTurn: { roomId: 'room-a', authorId: 'ana', turnId: 't1', teammate: true },
} as MessageOpts;
const owner: MessageOpts = {
  roomTurn: { roomId: 'room-a', authorId: 'ana', turnId: 't2' },
} as MessageOpts;

async function drain(stream: AsyncGenerator<StreamEvent>) {
  const seen: StreamEvent[] = [];
  for await (const event of stream) seen.push(event);
  return seen;
}

afterEach(() => setTeammateTurnCostSink(null));

describe('the teammate meter', () => {
  it('reports a teammate turn’s own cost, and passes every event through', async () => {
    const sink = vi.fn();
    setTeammateTurnCostSink(sink);
    const events = [status({ costUsd: 9.5, turnCostUsd: 0.42 }), done];

    const seen = await drain(meterTeammateTurns(runtime(events)).sendMessage('s', 'hi', teammate));

    expect(seen).toEqual(events);
    expect(sink).toHaveBeenCalledWith({ roomId: 'room-a', costUsd: 0.42 });
  });

  it('reports no cost, never the session’s running total, when the turn reported none', async () => {
    const sink = vi.fn();
    setTeammateTurnCostSink(sink);

    await drain(
      meterTeammateTurns(runtime([status({ costUsd: 9.5 }), done])).sendMessage('s', 'hi', teammate)
    );

    expect(sink).toHaveBeenCalledWith({ roomId: 'room-a', costUsd: undefined });
  });

  it('never counts the owner’s own turns, or a turn outside a room', async () => {
    const sink = vi.fn();
    setTeammateTurnCostSink(sink);
    const metered = meterTeammateTurns(runtime([status({ turnCostUsd: 1 }), done]));

    await drain(metered.sendMessage('s', 'hi', owner));
    await drain(metered.sendMessage('s', 'hi'));

    expect(sink).not.toHaveBeenCalled();
  });

  it('still counts a turn whose reader stopped early', async () => {
    const sink = vi.fn();
    setTeammateTurnCostSink(sink);
    const stream = meterTeammateTurns(runtime([status({ turnCostUsd: 0.1 }), done])).sendMessage(
      's',
      'hi',
      teammate
    );
    await stream.next();
    await stream.return(undefined);

    expect(sink).toHaveBeenCalledWith({ roomId: 'room-a', costUsd: 0.1 });
  });
});
