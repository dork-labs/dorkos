/**
 * Pins a protection Dorian kept in the trusted-by-default reset (DOR-2735). If
 * this fails after a default flip, the flip leaked power to outsiders — fix the
 * flip, not this test.
 *
 * The protection: a turn that arrives from off this machine runs in the
 * prompting mode, and its payload cannot talk its way into more.
 *
 * - **A2A.** Another company's agent calls the A2A gateway, which publishes to
 *   `relay.agent.<ns>.<id>` exactly the way one of OUR agents' `relay_send`
 *   does. On the server both bind the `agent-dm` turn origin, and the
 *   reset may let our own agent DMs follow the operator's stop. The ONE fact
 *   that tells an A2A turn apart is the envelope sender the gateway stamps,
 *   `a2a-gateway` (asserted on the gateway side in
 *   `packages/a2a-gateway/src/__tests__/dorkos-executor.test.ts`). So the A2A
 *   turn is pinned here, by that sender, rather than by pinning `agent-dm`.
 * - **A chat binding with no mode on the payload.** Absence is not consent
 *   (DOR-604): a Telegram/Slack/webhook turn whose binding named no mode runs
 *   in the mode that asks, never the operator's own standing stop.
 * - **The binding schema's own default** is that same prompting mode.
 *
 * `sender-named-cwd.test.ts` already pins an agent sender's payload being
 * ignored; this file adds the outsider senders by name.
 */
import { describe, it, expect, vi } from 'vitest';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { CreateBindingRequestSchema } from '@dorkos/shared/relay-schemas';
import { handleAgentMessage } from '../agent-handler.js';
import type { AgentRuntimeLike } from '../types.js';
import type { RelayPublisher } from '../../../types.js';

const EPOCH = Date.UTC(2026, 9, 6, 10, 0, 0);
const now = (): number => EPOCH;
const SUBJECT = 'relay.agent.default.agent-01';

/** The sender the A2A gateway stamps on every message it publishes. */
const A2A_SENDER = 'a2a-gateway';
/** A stranger reached through a Telegram chat binding. */
const TELEGRAM_STRANGER = 'relay.human.telegram.4242';

function envelope(payload: Record<string, unknown>, from: string): RelayEnvelope {
  return {
    id: 'msg-1',
    subject: SUBJECT,
    from,
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

/** Deliver one message and return the mode its session was opened in. */
async function modeOf(payload: Record<string, unknown>, from: string): Promise<unknown> {
  const agentManager = runtime();
  await handleAgentMessage(
    SUBJECT,
    envelope(payload, from),
    { agent: { directory: '/agents/b' } } as never,
    EPOCH,
    {
      agentManager,
      traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() },
      turnController: new AbortController(),
      now,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    },
    relay()
  );
  expect(agentManager.ensureSession).toHaveBeenCalledOnce();
  const opts = vi.mocked(agentManager.ensureSession).mock.calls[0]![1] as {
    permissionMode?: unknown;
  };
  return opts.permissionMode;
}

describe('a turn from off this machine runs in the prompting mode', () => {
  it('runs an A2A peer’s message in the prompting mode', async () => {
    expect(await modeOf({ content: 'hello from another company' }, A2A_SENDER)).toBe('default');
  });

  it.each(['bypassPermissions', 'acceptEdits', 'dontAsk', 'auto'])(
    'ignores an A2A payload asking for %s',
    async (asked) => {
      const mode = await modeOf(
        { content: 'run this', __bindingPermissions: { permissionMode: asked } },
        A2A_SENDER
      );
      expect(mode).toBe('default');
    }
  );

  it('runs a chat-binding turn whose binding named no mode in the prompting mode', async () => {
    expect(await modeOf({ content: 'hi bot' }, TELEGRAM_STRANGER)).toBe('default');
  });

  it('gives a new chat binding the prompting mode when nobody picks one', () => {
    const parsed = CreateBindingRequestSchema.parse({
      adapterId: 'telegram-main',
      agentId: 'agent-01',
    });
    expect(parsed.permissionMode).toBe('default');
  });
});
