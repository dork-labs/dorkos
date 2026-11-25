/**
 * Where a relay chat stands on its later turns (DOR-5245).
 *
 * A message into a chat that has run before names no folder when its sender
 * may not name one and its subject names no Mesh agent. The host's record says
 * where the chat stands and as whom, so every later turn runs there, after a
 * restart too. A chat counts as having run once a turn persisted its SDK id
 * or once the host holds it, never merely because a runtime holds its key in
 * memory. A new chat the server placed records its runtime and agent whatever
 * the subject's shape, so its later messages read that record.
 */
import { describe, it, expect, vi } from 'vitest';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { handleAgentMessage, type AgentHandlerDeps } from '../agent-handler.js';
import type { AgentRuntimeLike, ChatPlaceRecall } from '../types.js';
import type { AdapterContext, RelayPublisher } from '../../../types.js';
import { CARRIED_TURN_LIMITS_FIELD, sealTurnLimits } from '../../../lib/carried-turn-limits.js';

const EPOCH = Date.UTC(2026, 10, 25, 10, 0, 0);
const now = (): number => EPOCH;
const CHAT = '00000000-0000-4000-8000-0000000052c1';
const SUBJECT = `relay.agent.claude-code.${CHAT}`;
const SENDER = 'relay.agent.claude-code.sol-id';
const HOME = '/made-up/agents/sol';
const ELSEWHERE = '/made-up/elsewhere';
const SDK_ID = 'sdk-session-52c1';

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

/** A runtime that says something each turn and keeps the keys it was given, in memory. */
function keepingRuntime(): AgentRuntimeLike {
  const held = new Set<string>();
  const runtime: AgentRuntimeLike = {
    ensureSession: vi.fn((id: string) => void held.add(id)),
    sendMessage: vi.fn().mockImplementation(() =>
      (async function* () {
        yield { type: 'text_delta', data: { text: 'here' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    ),
    approveTool: vi.fn().mockReturnValue(true),
    interruptQuery: vi.fn().mockResolvedValue(true),
  };
  // What every real runtime answers about a key it holds in memory.
  return Object.assign(runtime, { hasSession: (id: string) => held.has(id) });
}

function relay(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'r', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

const logger = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() });

/** Deliver one message to the chat and return what ran. */
async function deliver(
  agentManager: AgentRuntimeLike,
  payload: Record<string, unknown>,
  deps: Partial<AgentHandlerDeps> = {},
  opts: { from?: string; context?: AdapterContext } = {}
) {
  return handleAgentMessage(
    SUBJECT,
    envelope({ content: 'hello', ...payload }, opts.from),
    opts.context,
    EPOCH,
    {
      agentManager,
      traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() },
      turnController: new AbortController(),
      now,
      logger: logger(),
      ...deps,
    },
    relay()
  );
}

/** Where the last turn ran, and as whom. */
function lastTurn(agentManager: AgentRuntimeLike) {
  const sent = vi.mocked(agentManager.sendMessage).mock.calls.at(-1)![2] as {
    cwd?: string;
    forAgent?: string;
  };
  const ensured = vi.mocked(agentManager.ensureSession).mock.calls.at(-1)![1] as {
    cwd?: string;
    hasStarted?: boolean;
  };
  return { cwd: sent.cwd, forAgent: sent.forAgent, ensuredCwd: ensured.cwd };
}

const placed = (cwd: string) => ({
  [CARRIED_TURN_LIMITS_FIELD]: sealTurnLimits(SENDER, {
    newChat: { sessionKey: CHAT, cwd, forAgent: HOME },
  }),
});

/** The store a renaming runtime left behind: this chat's scope maps to its SDK id. */
const persisted = { get: () => SDK_ID, set: vi.fn() };

describe('a relay chat that has run before', () => {
  it('runs in the folder and as the agent the host recorded, on a fresh runtime', async () => {
    const agentManager = keepingRuntime();
    const recallChatPlace = vi.fn<ChatPlaceRecall>().mockResolvedValue({
      cwd: HOME,
      forAgent: HOME,
    });

    await deliver(agentManager, {}, { recallChatPlace, agentSessionStore: persisted });

    expect(recallChatPlace).toHaveBeenCalledWith({ sessionKey: SDK_ID });
    expect(lastTurn(agentManager)).toEqual({ cwd: HOME, forAgent: HOME, ensuredCwd: HOME });
  });

  it('keeps the folder a shaping sender names, and asks the host nothing', async () => {
    const agentManager = keepingRuntime();
    const recallChatPlace = vi.fn<ChatPlaceRecall>().mockResolvedValue({ cwd: HOME });

    await deliver(
      agentManager,
      { cwd: ELSEWHERE },
      { recallChatPlace, agentSessionStore: persisted },
      { from: 'relay.human.console' }
    );

    expect(recallChatPlace).not.toHaveBeenCalled();
    expect(lastTurn(agentManager).cwd).toBe(ELSEWHERE);
  });

  it("keeps a Mesh agent's own home, and asks the host nothing", async () => {
    const agentManager = keepingRuntime();
    const recallChatPlace = vi.fn<ChatPlaceRecall>().mockResolvedValue({ cwd: HOME });
    const context = { agent: { directory: '/made-up/agents/ori', runtime: 'claude-code' } };

    await deliver(agentManager, {}, { recallChatPlace, agentSessionStore: persisted }, { context });

    expect(recallChatPlace).not.toHaveBeenCalled();
    expect(lastTurn(agentManager).cwd).toBe('/made-up/agents/ori');
  });

  it('runs as before when the host cannot read its record', async () => {
    const agentManager = keepingRuntime();
    const recallChatPlace = vi.fn<ChatPlaceRecall>().mockRejectedValue(new Error('db busy'));

    const result = await deliver(
      agentManager,
      {},
      { recallChatPlace, agentSessionStore: persisted }
    );

    expect(result.success).toBe(true);
    expect(lastTurn(agentManager)).toEqual({
      cwd: undefined,
      forAgent: undefined,
      ensuredCwd: undefined,
    });
  });

  it('is a new chat while the host holds nothing, so the sealed place opens it', async () => {
    const agentManager = keepingRuntime();
    const recallChatPlace = vi.fn<ChatPlaceRecall>().mockResolvedValue(null);

    await deliver(agentManager, placed(HOME), { recallChatPlace });

    expect(lastTurn(agentManager)).toEqual({ cwd: HOME, forAgent: HOME, ensuredCwd: HOME });
  });
});

describe('a runtime that keeps the key it was given', () => {
  it('reads the chat its first turn recorded on a later message, not a place it carries', async () => {
    const agentManager = keepingRuntime();
    const recorded = new Map<string, string>();
    const bindNewChat = vi.fn(async (binding: { sessionId: string; agentDirectory?: string }) => {
      if (binding.agentDirectory) recorded.set(binding.sessionId, binding.agentDirectory);
    });
    const recallChatPlace = vi.fn<ChatPlaceRecall>(async ({ sessionKey }) => {
      const home = recorded.get(sessionKey);
      return home === undefined ? null : { cwd: home, forAgent: home };
    });

    await deliver(agentManager, placed(HOME), { bindNewChat, recallChatPlace });
    await deliver(agentManager, placed(ELSEWHERE), { bindNewChat, recallChatPlace });

    expect(agentManager.sendMessage).toHaveBeenCalledTimes(2);
    expect(lastTurn(agentManager)).toEqual({ cwd: HOME, forAgent: HOME, ensuredCwd: HOME });
  });

  it('places a new chat the runtime holds in memory but never ran', async () => {
    const agentManager = keepingRuntime();
    // A settings change creates a session with no folder before any turn runs.
    agentManager.ensureSession(CHAT, { permissionMode: 'default', hasStarted: false });
    const recallChatPlace = vi.fn<ChatPlaceRecall>().mockResolvedValue(null);

    await deliver(agentManager, placed(HOME), { recallChatPlace });

    expect(lastTurn(agentManager)).toEqual({ cwd: HOME, forAgent: HOME, ensuredCwd: HOME });
  });
});

describe('a new chat the server placed', () => {
  it('records its runtime and agent under the key its next turn runs on', async () => {
    const agentManager = keepingRuntime();
    const bindNewChat = vi.fn().mockResolvedValue(undefined);

    await deliver(agentManager, placed(HOME), { bindNewChat, runtimeType: 'claude-code' });

    expect(bindNewChat).toHaveBeenCalledWith({
      sessionId: CHAT,
      runtimeType: 'claude-code',
      agentDirectory: HOME,
      from: SENDER,
    });
  });

  it('records nothing for a turn the server did not place', async () => {
    const agentManager = keepingRuntime();
    const bindNewChat = vi.fn().mockResolvedValue(undefined);

    await deliver(agentManager, {}, { bindNewChat });

    expect(bindNewChat).not.toHaveBeenCalled();
  });
});
