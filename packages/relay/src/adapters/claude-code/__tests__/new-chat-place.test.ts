/**
 * The place the server seals onto a message that starts a new chat (DOR-5209).
 *
 * A sender that may not shape a turn names no folder and no agent of its own.
 * When its message starts a chat, the server works out where that chat opens
 * (the sessions route's own rule) and seals it into the carried limits for
 * that sender and that chat. The handler stands the turn there and runs it as
 * that agent, and ignores a place nobody sealed, one sealed for someone else
 * or another chat, and any place on a conversation that has already run.
 */
import { describe, it, expect, vi } from 'vitest';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { handleAgentMessage } from '../agent-handler.js';
import type { AgentRuntimeLike, ExecutionSettingsResolver } from '../types.js';
import type { AdapterContext, RelayPublisher } from '../../../types.js';
import { CARRIED_TURN_LIMITS_FIELD, sealTurnLimits } from '../../../lib/carried-turn-limits.js';

const EPOCH = Date.UTC(2026, 10, 24, 10, 0, 0);
const now = (): number => EPOCH;
const CHAT = '00000000-0000-4000-8000-0000000052b1';
const SUBJECT = `relay.agent.claude-code.${CHAT}`;
const SENDER = 'relay.agent.claude-code.sol-id';
const HOME = '/made-up/agents/sol';
const PLACE = { sessionKey: CHAT, cwd: HOME, forAgent: HOME };

function envelope(payload: Record<string, unknown>, from = SENDER): RelayEnvelope {
  return {
    id: 'msg-1',
    subject: SUBJECT,
    from,
    replyTo: 'relay.inbox.query.q-1',
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

interface Turn {
  cwd?: string;
  forAgent?: string;
  ensuredCwd?: string;
  agentDirectory?: string;
}

/** Deliver one message and read where its turn ran, and as whom. */
async function turnOf(
  carried: unknown,
  opts: {
    from?: string;
    persisted?: string;
    context?: AdapterContext;
    extra?: Record<string, unknown>;
  } = {}
): Promise<Turn> {
  const agentManager = runtime();
  const resolveExecutionSettings = vi.fn().mockResolvedValue({});
  const payload = {
    content: 'hello',
    ...opts.extra,
    ...(carried !== undefined ? { [CARRIED_TURN_LIMITS_FIELD]: carried } : {}),
  };
  await handleAgentMessage(
    SUBJECT,
    envelope(payload, opts.from),
    opts.context,
    EPOCH,
    {
      agentManager,
      traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() },
      turnController: new AbortController(),
      now,
      resolveExecutionSettings: resolveExecutionSettings as ExecutionSettingsResolver,
      ...(opts.persisted ? { agentSessionStore: { get: () => opts.persisted, set: vi.fn() } } : {}),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    },
    relay()
  );
  const sent = vi.mocked(agentManager.sendMessage).mock.calls[0]![2] as Turn;
  const ensured = vi.mocked(agentManager.ensureSession).mock.calls[0]![1] as { cwd?: string };
  const settings = resolveExecutionSettings.mock.calls[0]![0] as { agentDirectory?: string };
  return {
    ...(sent.cwd !== undefined ? { cwd: sent.cwd } : {}),
    ...(sent.forAgent !== undefined ? { forAgent: sent.forAgent } : {}),
    ...(ensured.cwd !== undefined ? { ensuredCwd: ensured.cwd } : {}),
    ...(settings.agentDirectory !== undefined ? { agentDirectory: settings.agentDirectory } : {}),
  };
}

describe('a new chat the server placed', () => {
  it("opens in the agent's home and runs as that agent", async () => {
    expect(await turnOf(sealTurnLimits(SENDER, { newChat: PLACE }))).toEqual({
      cwd: HOME,
      forAgent: HOME,
      ensuredCwd: HOME,
      agentDirectory: HOME,
    });
  });

  it('opens there beside the limits the sender carries', async () => {
    const carried = sealTurnLimits(SENDER, { carriedMarks: { outsider: true }, newChat: PLACE });
    expect((await turnOf(carried)).cwd).toBe(HOME);
  });

  it('ignores a place nobody sealed', async () => {
    expect(await turnOf({ newChat: PLACE })).toEqual({});
  });

  it('ignores a place sealed for another sender', async () => {
    const carried = sealTurnLimits('relay.agent.claude-code.ori-id', { newChat: PLACE });
    expect(await turnOf(carried)).toEqual({});
  });

  it('ignores a place sealed for another chat', async () => {
    const carried = sealTurnLimits(SENDER, { newChat: { ...PLACE, sessionKey: 'other-chat' } });
    expect(await turnOf(carried)).toEqual({});
  });

  it('ignores a place once the conversation has run', async () => {
    // Sealed for the key the turn runs under, so only the conversation having run refuses it.
    const carried = sealTurnLimits(SENDER, { newChat: { ...PLACE, sessionKey: 'sdk-session-1' } });
    expect(await turnOf(carried, { persisted: 'sdk-session-1' })).toEqual({});
  });

  it("keeps a Mesh agent's own home ahead of a place", async () => {
    const carried = sealTurnLimits(SENDER, { newChat: { ...PLACE, cwd: '/made-up/elsewhere' } });
    const context = { agent: { directory: '/made-up/agents/ori', runtime: 'claude-code' } };
    expect(await turnOf(carried, { context })).toEqual({
      cwd: '/made-up/agents/ori',
      ensuredCwd: '/made-up/agents/ori',
      agentDirectory: '/made-up/agents/ori',
    });
  });

  it('ignores a place on a sender that shapes the turn, which keeps the folder it names', async () => {
    const person = 'relay.human.console';
    const carried = sealTurnLimits(person, { newChat: PLACE });
    const turn = await turnOf(carried, { from: person, extra: { cwd: '/made-up/projects/plain' } });
    expect(turn).toEqual({ cwd: '/made-up/projects/plain', ensuredCwd: '/made-up/projects/plain' });
  });

  it("ignores a payload's own folder and agent from a sender that may not shape the turn", async () => {
    const turn = await turnOf(sealTurnLimits(SENDER, { newChat: PLACE }), {
      extra: { cwd: '/made-up/agents/ori', forAgent: '/made-up/agents/ori' },
    });
    expect(turn).toEqual({ cwd: HOME, forAgent: HOME, ensuredCwd: HOME, agentDirectory: HOME });
  });
});
