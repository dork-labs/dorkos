/**
 * Power flows downstream, never up (spec `trusted-by-default-flip` §4), on the
 * relay half: a message addressed to an agent by a sender that may not shape
 * the turn — another agent, the A2A gateway, an external MCP client — runs no
 * looser than the runtime's default even in a conversation set looser, and the
 * conversation it starts is recorded with the sender, so the server can tell
 * one of our agents from a sender from outside.
 */
import { describe, it, expect, vi } from 'vitest';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { handleAgentMessage } from '../agent-handler.js';
import type { AgentRuntimeLike, SessionRuntimeBinder } from '../types.js';
import type { RelayPublisher } from '../../../types.js';

const EPOCH = Date.UTC(2026, 9, 6, 10, 0, 0);
const now = (): number => EPOCH;
const SUBJECT = 'relay.agent.default.agent-01';

function envelope(from: string): RelayEnvelope {
  return {
    id: 'msg-1',
    subject: SUBJECT,
    from,
    replyTo: 'relay.inbox.reply-1',
    budget: {
      hopCount: 1,
      maxHops: 5,
      ancestorChain: [],
      ttl: EPOCH + 60_000,
      callBudgetRemaining: 9,
    },
    createdAt: new Date(EPOCH).toISOString(),
    payload: { content: 'please do the thing' },
  };
}

function runtime(): AgentRuntimeLike {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(() =>
      (async function* () {
        yield { type: 'text_delta', data: { text: 'done' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    ),
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
    approveTool: vi.fn().mockReturnValue(true),
    interruptQuery: vi.fn().mockResolvedValue(true),
  };
}

function relay(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'r', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

/** Deliver one message; return what the turn was sent with and how it was bound. */
async function deliver(from: string) {
  const agentManager = runtime();
  const bindSessionRuntime = vi.fn<SessionRuntimeBinder>().mockResolvedValue(undefined);
  await handleAgentMessage(
    SUBJECT,
    envelope(from),
    { agent: { directory: '/agents/b' } } as never,
    EPOCH,
    {
      agentManager,
      traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() },
      turnController: new AbortController(),
      now,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      bindSessionRuntime,
    },
    relay()
  );
  expect(agentManager.sendMessage).toHaveBeenCalledOnce();
  const sent = vi.mocked(agentManager.sendMessage).mock.calls[0]![2] as {
    permissionCeiling?: unknown;
  };
  return { sent, bound: bindSessionRuntime.mock.calls[0]?.[0] };
}

describe('a relay message to an agent runs no looser than its sender may', () => {
  it.each(['relay.agent.default.agent-02', 'a2a-gateway', 'relay.external.mcp'])(
    'holds a turn %s started at the runtime default',
    async (from) => {
      const { sent } = await deliver(from);
      expect(sent.permissionCeiling).toBe('runtime-default');
    }
  );

  it('does not bound a turn a chat binding shaped (its mode is the binding’s)', async () => {
    const { sent } = await deliver('relay.human.telegram.4242');
    expect(sent.permissionCeiling).toBeUndefined();
  });
});

describe('the conversation is recorded with its sender', () => {
  it('passes the A2A gateway’s stamp to the binder, so it is never an agent DM', async () => {
    const { bound } = await deliver('a2a-gateway');
    expect(bound?.from).toBe('a2a-gateway');
  });

  it('passes one of our agents’ stamp too', async () => {
    const { bound } = await deliver('relay.agent.default.agent-02');
    expect(bound?.from).toBe('relay.agent.default.agent-02');
  });
});
