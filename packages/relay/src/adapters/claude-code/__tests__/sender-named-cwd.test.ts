/**
 * A folder a SENDER names is not trusted as the answering agent's desk (spec
 * `agent-home-desk` §3.4).
 *
 * Any agent can publish to another agent's subject with a payload `cwd`, and
 * the handler used to stand the turn there: in a room's shared files, or in a
 * third agent's folder. The host's desk check now decides, before anything
 * starts, and a refusal goes through the same door as an expired message —
 * no session, no send, a terminal error for the reply reader.
 *
 * Seeded: dropping the check from `handleAgentMessage` reddens the first case.
 */
import { describe, it, expect, vi } from 'vitest';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { handleAgentMessage } from '../agent-handler.js';
import type { AgentRuntimeLike, TurnDeskCheck } from '../types.js';
import type { RelayPublisher } from '../../../types.js';

const EPOCH = Date.UTC(2026, 8, 27, 10, 0, 0);
const now = (): number => EPOCH;
const SUBJECT = 'relay.agent.default.agent-01';

function envelope(payload: Record<string, unknown>): RelayEnvelope {
  return {
    id: 'msg-1',
    subject: SUBJECT,
    from: 'relay.agent.default.agent-02',
    replyTo: 'relay.a2a.reply.task-1.nonce',
    budget: {
      hopCount: 1,
      maxHops: 5,
      ancestorChain: [],
      ttl: EPOCH + 60_000,
      callBudgetRemaining: 9,
    },
    createdAt: new Date(EPOCH).toISOString(),
    payload,
  };
}

function runtime(): AgentRuntimeLike {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(() =>
      (async function* () {
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

function deliver(
  payload: Record<string, unknown>,
  agentManager: AgentRuntimeLike,
  checkTurnDesk: TurnDeskCheck | undefined
) {
  return handleAgentMessage(
    SUBJECT,
    envelope(payload),
    { agent: { directory: '/agents/b' } } as never,
    EPOCH,
    {
      agentManager,
      traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() },
      turnController: new AbortController(),
      now,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      ...(checkTurnDesk ? { checkTurnDesk } : {}),
    },
    relay()
  );
}

describe('a folder the sender names (spec `agent-home-desk` §3.4)', () => {
  it('refuses a turn the desk check refuses: no session, no send, the reason reported', async () => {
    const agentManager = runtime();
    const check = vi.fn<TurnDeskCheck>(async () => 'That folder is a room’s shared files.');

    const result = await deliver(
      { content: 'hi', cwd: '/dork/rooms/r1/repo' },
      agentManager,
      check
    );

    expect(check).toHaveBeenCalledWith({
      cwd: '/dork/rooms/r1/repo',
      agentDirectory: '/agents/b',
      forAgent: undefined,
      sessionKey: expect.any(String),
    });
    expect(agentManager.ensureSession).not.toHaveBeenCalled();
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toBe('That folder is a room’s shared files.');
  });

  it('refuses when the check itself fails — a folder nobody could vouch for is no desk', async () => {
    const agentManager = runtime();

    const result = await deliver({ content: 'hi', cwd: '/elsewhere' }, agentManager, () =>
      Promise.reject(new Error('registry unreadable'))
    );

    expect(agentManager.sendMessage).not.toHaveBeenCalled();
    expect(result.error).toBe('registry unreadable');
  });

  it('runs a turn the check allows, and asks nothing when no folder is named', async () => {
    const allowed = runtime();
    const check = vi.fn<TurnDeskCheck>(async () => null);
    await deliver({ content: 'hi', cwd: '/agents/b' }, allowed, check);
    expect(allowed.sendMessage).toHaveBeenCalledOnce();

    const unnamed = runtime();
    const untouched = vi.fn<TurnDeskCheck>(async () => 'never');
    await deliver({ content: 'hi' }, unnamed, untouched);
    expect(untouched).not.toHaveBeenCalled();
    expect(unnamed.sendMessage).toHaveBeenCalledOnce();
  });
});
