/**
 * A relay turn tells its host who started it BEFORE it runs (spec `heartbeats`,
 * PR 3 review B1), so whatever the turn calls already knows whether a stranger
 * started it — on the first A2A turn and on a bridged chat's turn alike.
 */
import { describe, it, expect, vi } from 'vitest';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { handleAgentMessage } from '../agent-handler.js';
import type { AgentRuntimeLike } from '../types.js';
import type { RelayPublisher } from '../../../types.js';

const EPOCH = Date.UTC(2026, 9, 6, 10, 0, 0);
const SUBJECT = 'relay.agent.default.agent-01';

/** One envelope from a sender. */
function envelope(from: string): RelayEnvelope {
  return {
    id: 'msg-1',
    subject: SUBJECT,
    from,
    replyTo: 'relay.inbox.reply',
    budget: {
      hopCount: 1,
      maxHops: 5,
      ancestorChain: [],
      ttl: EPOCH + 60_000,
      callBudgetRemaining: 9,
    },
    createdAt: new Date(EPOCH).toISOString(),
    payload: { content: 'hello' },
  };
}

/** Run one turn and return what the note saw and in which order. */
async function runTurn(from: string) {
  const order: string[] = [];
  const notes: Array<{ sessionId: string; from: string }> = [];
  const agentManager: AgentRuntimeLike = {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(() => {
      order.push('send');
      return (async function* () {
        yield { type: 'done', data: {} } as StreamEvent;
      })();
    }),
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
    approveTool: vi.fn().mockReturnValue(true),
    interruptQuery: vi.fn().mockResolvedValue(true),
  };
  const relay: RelayPublisher = {
    publish: vi.fn().mockResolvedValue({ messageId: 'r', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
  await handleAgentMessage(
    SUBJECT,
    envelope(from),
    { agent: { directory: '/agents/b' } } as never,
    EPOCH,
    {
      agentManager,
      traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() },
      turnController: new AbortController(),
      now: () => EPOCH,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      noteTurnStart: (turn) => {
        order.push('note');
        notes.push(turn);
      },
    },
    relay
  );
  return { order, notes };
}

describe('noteTurnStart', () => {
  it.each(['a2a-gateway', 'relay.human.telegram.4242', 'relay.agent.default.agent-02'])(
    'is told who sent the message before the turn runs (%s)',
    async (from) => {
      const { order, notes } = await runTurn(from);
      expect(order).toEqual(['note', 'send']);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.from).toBe(from);
      expect(notes[0]!.sessionId).toBeTruthy();
    }
  );
});
