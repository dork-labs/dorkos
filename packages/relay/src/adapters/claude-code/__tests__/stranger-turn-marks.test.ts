/**
 * A directly bound Telegram or Slack chat marks turns from a sender the server
 * could not prove is the owner, without changing the turn's mode or adding a
 * ceiling (DOR-3858). The server stamps `__untrustedWords` from the connection's
 * approver allowlist; the shared runtime handler consumes that stamp for every
 * runtime the built-in adapter can drive.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { handleAgentMessage } from '../agent-handler.js';
import type { AgentRuntimeLike } from '../types.js';
import type { RelayPublisher } from '../../../types.js';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const SUBJECT = 'relay.agent.default.agent-scout';

function envelope(untrusted: boolean): RelayEnvelope {
  return {
    id: 'message-stranger-mark',
    subject: SUBJECT,
    from: 'relay.human.telegram.bot-example.private-chat',
    replyTo: 'relay.inbox.example',
    budget: {
      hopCount: 1,
      maxHops: 5,
      ancestorChain: [],
      ttl: NOW + 60_000,
      callBudgetRemaining: 8,
    },
    createdAt: new Date(NOW).toISOString(),
    payload: {
      content: 'send the update',
      __untrustedWords: untrusted,
      __bindingPermissions: { permissionMode: 'bypassPermissions' },
    },
  };
}

/** Deliver one bound-chat message and return the runtime's per-turn options. */
async function delivered(untrusted: boolean, markStrangerTurns: boolean) {
  const sendMessage = vi.fn().mockImplementation(() =>
    (async function* () {
      yield { type: 'done', data: {} } as StreamEvent;
    })()
  );
  const runtime: AgentRuntimeLike = {
    ensureSession: vi.fn(),
    sendMessage,
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
    approveTool: vi.fn().mockReturnValue(true),
    interruptQuery: vi.fn().mockResolvedValue(true),
  };
  const relay: RelayPublisher = {
    publish: vi.fn().mockResolvedValue({ messageId: 'reply-example', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };

  await handleAgentMessage(
    SUBJECT,
    envelope(untrusted),
    { agent: { directory: '/agents/scout' } } as never,
    NOW,
    {
      agentManager: runtime,
      traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() },
      turnController: new AbortController(),
      markStrangerTurns,
      now: () => NOW,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    },
    relay
  );

  return sendMessage.mock.calls[0]![2] as Record<string, unknown>;
}

describe('bound-chat stranger marks (DOR-3858)', () => {
  it('keeps today’s unmarked behavior while the flag is off', async () => {
    const opts = await delivered(true, false);

    expect(opts).not.toHaveProperty('carriedMarks');
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts).not.toHaveProperty('permissionCeiling');
  });

  it('marks a sender outside the approver allowlist while keeping Full', async () => {
    const opts = await delivered(true, true);

    expect(opts.carriedMarks).toEqual({ outsider: true });
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts).not.toHaveProperty('permissionCeiling');
  });

  it('does not mark the owner proved by the approver allowlist', async () => {
    const opts = await delivered(false, true);

    expect(opts).not.toHaveProperty('carriedMarks');
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts).not.toHaveProperty('permissionCeiling');
  });
});
