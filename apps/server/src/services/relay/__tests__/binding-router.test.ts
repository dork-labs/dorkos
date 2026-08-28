import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BindingRouter,
  type RelayCoreLike,
  type AgentSessionCreator,
  type RuntimeTypeResolver,
} from '../binding-router.js';
import type { BindingStore } from '../binding-store.js';
import type { AdapterMeshCoreLike } from '../adapter-manager.js';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { isDispatchId, newDispatchId } from '@dorkos/shared/dispatch-id';
import { currentDispatchId } from '../../../lib/dispatch-context.js';
import { recentDispatches, resetDispatchBuffers } from '../../observability/dispatch-buffers.js';

vi.mock('node:fs/promises');

/** The bound agent's own directory — who it is. */
const AGENT_PATH = '/agents/a';

/**
 * Where a turn for that agent RUNS, per the agent-cwd chain
 * (`services/workspace/resolve-session-cwd.ts`), which this file injects a
 * stand-in for. Deliberately a DIFFERENT path from {@link AGENT_PATH}: a router
 * that went back to stamping the raw project path would still look right if the
 * two matched, and would fail every cwd assertion below as it should.
 *
 * The real chain is exercised end to end by `binding-router.integration.test.ts`
 * — it cannot run here, because this file mocks `node:fs/promises` wholesale and
 * the boundary check the chain performs needs a real filesystem.
 */
const AGENT_CWD = '/agents/a/worktree';

/** The injected stand-in for the agent-cwd chain. */
const fakeResolveCwd = async ({ agentPath }: { agentPath: string }): Promise<{ cwd: string }> =>
  agentPath === AGENT_PATH ? { cwd: AGENT_CWD } : { cwd: agentPath };

describe('BindingRouter', () => {
  let router: BindingRouter;
  let mockRelayCore: RelayCoreLike;
  let mockAgentManager: AgentSessionCreator;
  let mockMeshCore: AdapterMeshCoreLike;
  let mockBindingStore: Partial<BindingStore>;
  let mockRuntimeResolver: RuntimeTypeResolver;
  let mockBridgeIngest: { ingest: ReturnType<typeof vi.fn> };
  let capturedHandler: ((envelope: Record<string, unknown>) => Promise<void>) | undefined;
  const mockUnsubscribe = vi.fn();

  beforeEach(async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue();
    vi.mocked(rename).mockResolvedValue();
    capturedHandler = undefined;

    mockRelayCore = {
      publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
      subscribe: vi.fn((pattern: string, handler: unknown) => {
        capturedHandler = handler as typeof capturedHandler;
        return mockUnsubscribe;
      }),
    };

    mockAgentManager = {
      createSession: vi.fn().mockResolvedValue({ id: 'session-abc' }),
    };

    // A stand-in for the inbound chat bridge. A `bridge: 'room'` binding routes
    // here (chats-as-channels §5.1) instead of to session dispatch; most tests
    // use unbridged bindings and never touch it.
    mockBridgeIngest = {
      ingest: vi.fn().mockResolvedValue({ status: 'ingested', entryId: 'e1', joined: false }),
    };

    mockMeshCore = {
      getProjectPath: vi.fn().mockReturnValue(AGENT_PATH),
    };

    mockBindingStore = {
      resolve: vi.fn(),
      resolveIncludingDisabled: vi.fn(),
      getById: vi.fn(),
    };

    mockRuntimeResolver = {
      getSessionRuntimeType: vi.fn().mockResolvedValue('claude-code'),
    };

    router = new BindingRouter({
      resolveCwd: fakeResolveCwd,
      bindingStore: mockBindingStore as BindingStore,
      relayCore: mockRelayCore,
      agentManager: mockAgentManager,
      meshCore: mockMeshCore,
      relayDir: '/tmp/relay',
      runtimeResolver: mockRuntimeResolver,
      bridgeIngest: mockBridgeIngest,
    });
    await router.init();
  });

  afterEach(async () => {
    await router.shutdown();
    vi.restoreAllMocks();
  });

  it('subscribes to relay.human.> on init', () => {
    expect(mockRelayCore.subscribe).toHaveBeenCalledWith('relay.human.>', expect.any(Function));
  });

  it('skips messages with unparseable subjects', async () => {
    const envelope = {
      id: 'msg-1',
      subject: 'relay.agent.xxx',
      payload: 'hi',
      from: 'tg',
      budget: {
        hopCount: 0,
        maxHops: 5,
        ttl: Date.now() + 60000,
        callBudgetRemaining: 10,
        ancestorChain: [],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await capturedHandler!(envelope);
    expect(mockBindingStore.resolve).not.toHaveBeenCalled();
    expect(mockRelayCore.publish).not.toHaveBeenCalled();
  });

  it('skips when no binding matches', async () => {
    vi.mocked(mockBindingStore.resolve!).mockReturnValue(undefined);
    const envelope = {
      id: 'msg-1',
      subject: 'relay.human.telegram.tg-bot.123',
      payload: 'hi',
      from: 'tg',
      budget: {
        hopCount: 0,
        maxHops: 5,
        ttl: Date.now() + 60000,
        callBudgetRemaining: 10,
        ancestorChain: [],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await capturedHandler!(envelope);
    expect(mockRelayCore.publish).not.toHaveBeenCalled();
  });

  it('skips envelopes originating from agents to prevent feedback loop', async () => {
    vi.mocked(mockBindingStore.resolve!).mockReturnValue({
      id: 'bind-1',
      adapterId: 'tg-bot',
      agentId: 'agent-a',
      permissionMode: 'acceptEdits' as const,
      sessionStrategy: 'per-chat',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await capturedHandler!({
      subject: 'relay.human.telegram.tg-bot.12345',
      from: 'agent:session-abc',
      replyTo: undefined,
      payload: { type: 'text_delta', data: { text: 'hello' } },
      budget: {
        hopCount: 1,
        maxHops: 10,
        ttl: Date.now() + 60000,
        callBudgetRemaining: 10,
        ancestorChain: [],
      },
      id: 'msg-response',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    // Should NOT have published — this is an agent response, not a human message
    expect(mockRelayCore.publish).not.toHaveBeenCalled();
    expect(mockBindingStore.resolve).not.toHaveBeenCalled();
  });

  it('routes human-originated messages normally', async () => {
    vi.mocked(mockBindingStore.resolve!).mockReturnValue({
      id: 'bind-1',
      adapterId: 'tg-bot',
      agentId: 'agent-a',
      permissionMode: 'acceptEdits' as const,
      sessionStrategy: 'per-chat',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await capturedHandler!({
      subject: 'relay.human.telegram.tg-bot.12345',
      from: 'relay.human.telegram.bot',
      replyTo: 'relay.human.telegram.tg-bot.12345',
      payload: { content: 'Hello from Telegram' },
      budget: {
        hopCount: 0,
        maxHops: 10,
        ttl: Date.now() + 60000,
        callBudgetRemaining: 10,
        ancestorChain: [],
      },
      id: 'msg-inbound',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    expect(mockRelayCore.publish).toHaveBeenCalledWith(
      'relay.agent.claude-code.session-abc',
      expect.anything(),
      expect.objectContaining({ from: 'relay.human.telegram.bot' })
    );
  });

  it('routes to relay.agent.{runtimeType}.{sessionId} when binding matches', async () => {
    vi.mocked(mockBindingStore.resolve!).mockReturnValue({
      id: 'bind-1',
      adapterId: 'tg-bot',
      agentId: 'agent-a',
      permissionMode: 'acceptEdits' as const,
      sessionStrategy: 'per-chat',
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const envelope = {
      id: 'msg-1',
      subject: 'relay.human.telegram.tg-bot.123',
      payload: { text: 'hello' },
      from: 'tg',
      budget: {
        hopCount: 0,
        maxHops: 5,
        ttl: Date.now() + 60000,
        callBudgetRemaining: 10,
        ancestorChain: [],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await capturedHandler!(envelope);
    expect(mockAgentManager.createSession).toHaveBeenCalledWith(AGENT_CWD, 'acceptEdits');
    expect(mockRelayCore.publish).toHaveBeenCalledWith(
      'relay.agent.claude-code.session-abc',
      expect.objectContaining({ text: 'hello', cwd: AGENT_CWD }),
      expect.objectContaining({ from: 'tg' })
    );
  });

  describe('the dispatch id crosses the bus', () => {
    /** The binding every case below routes through. */
    function bindOne(): void {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'tg-bot',
        agentId: 'agent-a',
        permissionMode: 'acceptEdits' as const,
        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    }

    /** One inbound chat envelope, optionally carrying a correlation id. */
    function inbound(dispatchId?: string): Record<string, unknown> {
      return {
        id: 'msg-inbound',
        subject: 'relay.human.telegram.tg-bot.123',
        payload: { text: 'hello' },
        from: 'tg',
        budget: {
          hopCount: 0,
          maxHops: 5,
          ttl: Date.now() + 60000,
          callBudgetRemaining: 10,
          ancestorChain: [],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        ...(dispatchId !== undefined ? { dispatchId } : {}),
      };
    }

    /** The `dispatchId` the router forwarded on its republish. */
    function forwardedId(): unknown {
      const options = vi.mocked(mockRelayCore.publish).mock.calls.at(-1)?.[2] as
        { dispatchId?: unknown } | undefined;
      return options?.dispatchId;
    }

    it('continues a dispatch the envelope already carries', async () => {
      // The gap this closes: a republish mints a FRESH ULID, so the inbound and
      // outbound message ids of one logical delivery are unrelated values and
      // nothing joins the two hops.
      bindOne();
      const carried = newDispatchId();
      await capturedHandler!(inbound(carried));
      expect(forwardedId()).toBe(carried);
    });

    it('starts a fresh dispatch when the envelope carries none', async () => {
      bindOne();
      await capturedHandler!(inbound());
      expect(isDispatchId(forwardedId() as string)).toBe(true);
    });

    it('refuses to adopt a malformed id from the wire', async () => {
      // An envelope arrives from another process, and with a remote adapter from
      // another machine. Adopting whatever it says would make the traceId a
      // value a stranger chose — grouping unrelated spans into one fiction.
      bindOne();
      await capturedHandler!(inbound('../../etc/passwd'));
      const minted = forwardedId() as string;
      expect(minted).not.toBe('../../etc/passwd');
      expect(isDispatchId(minted)).toBe(true);
    });

    it('opens no dispatch at all for a message this server produced', async () => {
      // The ring is 256 entries and every agent reply rides a relay.human.*
      // subject. A start-only row per reply flushed the real dispatches out of
      // the surface at reply rate — the buffer filled with rows that were never
      // dispatches and could never be closed.
      bindOne();
      resetDispatchBuffers();
      for (const from of ['agent:ana', 'relay.system.notice']) {
        await capturedHandler!({ ...inbound(), from });
      }
      expect(recentDispatches(10)).toHaveLength(0);
      expect(mockRelayCore.publish).not.toHaveBeenCalled();
    });

    it('closes the dispatch when the chat subject cannot be read', async () => {
      resetDispatchBuffers();
      await capturedHandler!({ ...inbound(), subject: 'relay.agent.nonsense' });
      const [row] = recentDispatches(10);
      expect(row).toBeDefined();
      expect(row.outcome).toBe('refused');
      expect(row.endedAt).not.toBeNull();
    });

    it('closes the dispatch when nothing connects the chat to an agent', async () => {
      // Both drops return before a binding is resolved, so neither can go
      // through `refuse()` — which is where every other refusal closes its row.
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(undefined);
      resetDispatchBuffers();
      await capturedHandler!(inbound());
      const [row] = recentDispatches(10);
      expect(row).toBeDefined();
      expect(row.outcome).toBe('refused');
      expect(row.endedAt).not.toBeNull();
    });

    it('leaves no dispatch open once a bound message has been routed or refused', async () => {
      // The property, rather than three instances of it: whatever an inbound
      // message does, it must not still read as running afterwards.
      bindOne();
      resetDispatchBuffers();
      await capturedHandler!(inbound());
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(undefined);
      await capturedHandler!(inbound());
      await capturedHandler!({ ...inbound(), subject: 'relay.agent.nonsense' });
      expect(recentDispatches(10).filter((d) => d.outcome === null)).toEqual([]);
    });

    it('makes the id ambient for everything the routing does', async () => {
      // The publish call itself is what carries the id onward; this proves the
      // ALS scope is live for the work in between, so every existing log line on
      // the inbound path gains the id without being edited.
      bindOne();
      const carried = newDispatchId();
      let ambient: string | undefined;
      vi.mocked(mockAgentManager.createSession).mockImplementation(async () => {
        ambient = currentDispatchId();
        return { id: 'session-abc' };
      });
      await capturedHandler!(inbound(carried));
      expect(ambient).toBe(carried);
    });
  });

  it('resolves binding with adapterId (instance ID) and chatId from subject', async () => {
    vi.mocked(mockBindingStore.resolve!).mockReturnValue(undefined);
    const envelope = {
      id: 'msg-1',
      subject: 'relay.human.telegram.tg-bot.12345',
      payload: 'hi',
      from: 'tg',
      budget: {
        hopCount: 0,
        maxHops: 5,
        ttl: Date.now() + 60000,
        callBudgetRemaining: 10,
        ancestorChain: [],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await capturedHandler!(envelope);
    expect(mockBindingStore.resolve).toHaveBeenCalledWith('tg-bot', '12345', undefined);
  });

  // Subject parsing lives in the shared `parseHumanSubject` helper
  // (services/relay/human-subject.ts) and is covered by human-subject.test.ts.

  describe('session strategies', () => {
    const makeBinding = (strategy: string) => ({
      id: 'bind-1',
      adapterId: 'tg-bot',
      agentId: 'agent-a',
      permissionMode: 'acceptEdits' as const,
      sessionStrategy: strategy,
      label: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const makeEnvelope = (chatId: string) => ({
      id: 'msg-1',
      subject: `relay.human.telegram.tg-bot.${chatId}`,
      payload: 'hi',
      from: 'tg',
      budget: {
        hopCount: 0,
        maxHops: 5,
        ttl: Date.now() + 60000,
        callBudgetRemaining: 10,
        ancestorChain: [],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    it('reuses session for per-chat strategy with same chatId', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding('per-chat'));
      const envelope = makeEnvelope('123');
      await capturedHandler!(envelope);
      await capturedHandler!(envelope); // second call
      // createSession should only be called once (reuse)
      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(1);
    });

    it('creates separate sessions for per-chat strategy with different chatIds', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding('per-chat'));
      await capturedHandler!(makeEnvelope('123'));
      await capturedHandler!(makeEnvelope('456'));
      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(2);
    });

    it('creates new session every time for stateless strategy', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding('stateless'));
      const envelope = makeEnvelope('123');
      await capturedHandler!(envelope);
      await capturedHandler!(envelope); // second call
      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(2);
    });

    /**
     * An envelope shaped like a real inbound chat message: a StandardPayload
     * whose `platformData` carries the author's platform id.
     *
     * @param chatId - The chat the message arrived in.
     * @param platformData - The adapter's platform block.
     */
    const makeChatEnvelope = (chatId: string, platformData: Record<string, unknown>) => ({
      ...makeEnvelope(chatId),
      payload: { content: 'hi', platformData },
    });

    describe('per-user', () => {
      // `per-user` used to read `envelope.metadata?.userId` — a field the relay
      // envelope does not have — so it always fell back to the chat id and was
      // byte-identical to `per-chat`. In a shared channel that put everyone's
      // conversation in one session, where the next person's turn could read
      // what the last person said. The real id is in the payload the adapters
      // build.

      it('gives two Slack users in one channel two sessions', async () => {
        vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding('per-user'));

        await capturedHandler!(makeChatEnvelope('C123', { channelId: 'C123', userId: 'U-alice' }));
        await capturedHandler!(makeChatEnvelope('C123', { channelId: 'C123', userId: 'U-bob' }));

        expect(mockAgentManager.createSession).toHaveBeenCalledTimes(2);
      });

      it("reuses one Slack user's session across their messages", async () => {
        vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding('per-user'));

        await capturedHandler!(makeChatEnvelope('C123', { channelId: 'C123', userId: 'U-alice' }));
        await capturedHandler!(makeChatEnvelope('C123', { channelId: 'C123', userId: 'U-alice' }));

        expect(mockAgentManager.createSession).toHaveBeenCalledTimes(1);
      });

      it('gives two Telegram users in one group two sessions (numeric fromId)', async () => {
        vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding('per-user'));

        await capturedHandler!(makeChatEnvelope('-100', { chatId: -100, fromId: 111 }));
        await capturedHandler!(makeChatEnvelope('-100', { chatId: -100, fromId: 222 }));

        expect(mockAgentManager.createSession).toHaveBeenCalledTimes(2);
      });

      it("reuses one Telegram user's session across their messages", async () => {
        vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding('per-user'));

        await capturedHandler!(makeChatEnvelope('-100', { chatId: -100, fromId: 111 }));
        await capturedHandler!(makeChatEnvelope('-100', { chatId: -100, fromId: 111 }));

        expect(mockAgentManager.createSession).toHaveBeenCalledTimes(1);
      });

      it('separates the same user id across two different bindings', async () => {
        // The key is scoped by binding, so one person talking to two agents is
        // still two conversations.
        vi.mocked(mockBindingStore.resolve!).mockReturnValueOnce(makeBinding('per-user'));
        await capturedHandler!(makeChatEnvelope('C123', { userId: 'U-alice' }));

        vi.mocked(mockBindingStore.resolve!).mockReturnValueOnce({
          ...makeBinding('per-user'),
          id: 'bind-2',
        });
        await capturedHandler!(makeChatEnvelope('C123', { userId: 'U-alice' }));

        expect(mockAgentManager.createSession).toHaveBeenCalledTimes(2);
      });

      it('falls back to the chat when the message carries no platform user id', async () => {
        vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding('per-user'));
        const envelope = makeEnvelope('123');

        await capturedHandler!(envelope);
        await capturedHandler!(envelope);

        expect(mockAgentManager.createSession).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('session persistence', () => {
    it('saves session map to disk after creating a session', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'tg-bot',
        agentId: 'agent-a',

        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await capturedHandler!({
        id: 'msg-1',
        subject: 'relay.human.telegram.tg-bot.123',
        payload: 'hi',
        from: 'tg',
        budget: {
          hopCount: 0,
          maxHops: 5,
          ttl: Date.now() + 60000,
          callBudgetRemaining: 10,
          ancestorChain: [],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      expect(writeFile).toHaveBeenCalled();
      expect(rename).toHaveBeenCalled();
    });

    it('loads session map from disk on init', async () => {
      const entries: [string, string][] = [['bind-1:chat:123', 'session-existing']];
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(entries));

      const freshRouter = new BindingRouter({
        resolveCwd: fakeResolveCwd,
        bindingStore: mockBindingStore as BindingStore,
        relayCore: mockRelayCore,
        agentManager: mockAgentManager,
        meshCore: mockMeshCore,
        relayDir: '/tmp/relay',
        runtimeResolver: mockRuntimeResolver,
      });
      await freshRouter.init();

      // Now route a message to the same binding+chat — should reuse existing session
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'tg-bot',
        agentId: 'agent-a',

        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      // Get the handler registered by the fresh router
      const freshHandler = (mockRelayCore.subscribe as ReturnType<typeof vi.fn>).mock.calls.at(
        -1
      )?.[1] as typeof capturedHandler;

      await freshHandler!({
        id: 'msg-1',
        subject: 'relay.human.telegram.tg-bot.123',
        payload: 'hi',
        from: 'tg',
        budget: {
          hopCount: 0,
          maxHops: 5,
          ttl: Date.now() + 60000,
          callBudgetRemaining: 10,
          ancestorChain: [],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      // Should NOT create a new session — reuses persisted one
      expect(mockAgentManager.createSession).not.toHaveBeenCalled();
      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        'relay.agent.claude-code.session-existing',
        'hi',
        expect.any(Object)
      );

      await freshRouter.shutdown();
    });
  });

  describe('cleanupOrphanedSessions()', () => {
    it('removes session entries for deleted bindings', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'tg-bot',
        agentId: 'agent-a',

        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      // Create a session
      await capturedHandler!({
        id: 'msg-1',
        subject: 'relay.human.telegram.tg-bot.123',
        payload: 'hi',
        from: 'tg',
        budget: {
          hopCount: 0,
          maxHops: 5,
          ttl: Date.now() + 60000,
          callBudgetRemaining: 10,
          ancestorChain: [],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(1);

      // Clean up with empty active bindings — should remove the orphaned entry
      const removed = await router.cleanupOrphanedSessions(new Set());
      expect(removed).toBe(1);

      // Now route again — should create a NEW session since the old one was cleaned up
      await capturedHandler!({
        id: 'msg-2',
        subject: 'relay.human.telegram.tg-bot.123',
        payload: 'hi again',
        from: 'tg',
        budget: {
          hopCount: 0,
          maxHops: 5,
          ttl: Date.now() + 60000,
          callBudgetRemaining: 10,
          ancestorChain: [],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(2);
    });

    it('preserves session entries for active bindings', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'tg-bot',
        agentId: 'agent-a',

        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      await capturedHandler!({
        id: 'msg-1',
        subject: 'relay.human.telegram.tg-bot.123',
        payload: 'hi',
        from: 'tg',
        budget: {
          hopCount: 0,
          maxHops: 5,
          ttl: Date.now() + 60000,
          callBudgetRemaining: 10,
          ancestorChain: [],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      const removed = await router.cleanupOrphanedSessions(new Set(['bind-1']));
      expect(removed).toBe(0);
    });

    it('returns 0 when no orphaned sessions exist', async () => {
      const removed = await router.cleanupOrphanedSessions(new Set());
      expect(removed).toBe(0);
    });
  });

  describe('error handling (C2)', () => {
    it('catches and logs errors when publish() throws', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'tg-bot',
        agentId: 'agent-a',

        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      vi.mocked(mockRelayCore.publish).mockRejectedValue(new Error('publish failed'));

      // Does not throw — and says the message was NOT handled, so the publish
      // pipeline stops counting a thrown dispatch as a delivery (DOR-789).
      await expect(
        capturedHandler!({
          id: 'msg-1',
          subject: 'relay.human.telegram.tg-bot.123',
          payload: 'hi',
          from: 'tg',
          budget: {
            hopCount: 0,
            maxHops: 5,
            ttl: Date.now() + 60000,
            callBudgetRemaining: 10,
            ancestorChain: [],
          },
          createdAt: '2026-01-01T00:00:00.000Z',
        })
      ).resolves.toEqual({ handled: false, reason: 'publish failed' });
    });

    it('catches and logs errors when createSession() throws', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'tg-bot',
        agentId: 'agent-a',

        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      vi.mocked(mockAgentManager.createSession).mockRejectedValue(
        new Error('session creation failed')
      );

      await expect(
        capturedHandler!({
          id: 'msg-1',
          subject: 'relay.human.telegram.tg-bot.123',
          payload: 'hi',
          from: 'tg',
          budget: {
            hopCount: 0,
            maxHops: 5,
            ttl: Date.now() + 60000,
            callBudgetRemaining: 10,
            ancestorChain: [],
          },
          createdAt: '2026-01-01T00:00:00.000Z',
        })
      ).resolves.toEqual({ handled: false, reason: 'session creation failed' });
    });
  });

  describe('concurrent session creation (C1)', () => {
    it('deduplicates concurrent calls for same key', async () => {
      // Make createSession slow so concurrent calls overlap
      let resolveSession!: (value: { id: string }) => void;
      vi.mocked(mockAgentManager.createSession).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSession = resolve;
          })
      );

      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'tg-bot',
        agentId: 'agent-a',

        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      const envelope = {
        id: 'msg-1',
        subject: 'relay.human.telegram.tg-bot.123',
        payload: 'hi',
        from: 'tg',
        budget: {
          hopCount: 0,
          maxHops: 5,
          ttl: Date.now() + 60000,
          callBudgetRemaining: 10,
          ancestorChain: [],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      };

      // Fire two concurrent calls before the session resolves
      const p1 = capturedHandler!(envelope);
      const p2 = capturedHandler!(envelope);

      // Let both handlers reach `createSession`. Session creation now awaits the
      // agent-cwd chain first, so `resolveSession` is not assigned in the same
      // tick the handlers were fired in.
      await vi.waitFor(() => expect(mockAgentManager.createSession).toHaveBeenCalled());

      // Resolve the single session creation
      resolveSession({ id: 'session-deduped' });
      await p1;
      await p2;

      // createSession should only be called ONCE despite two concurrent requests
      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(1);
      // Both should publish to the same session
      expect(mockRelayCore.publish).toHaveBeenCalledTimes(2);
      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        'relay.agent.claude-code.session-deduped',
        'hi',
        expect.any(Object)
      );
    });
  });

  describe('session map eviction (I6)', () => {
    it('evicts oldest entries when exceeding MAX_SESSIONS', async () => {
      // Pre-populate the session map via loading from disk
      const entries: [string, string][] = [];
      for (let i = 0; i < 10_000; i++) {
        entries.push([`bind-old:chat:${i}`, `session-${i}`]);
      }
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(entries));

      const evictionRouter = new BindingRouter({
        resolveCwd: fakeResolveCwd,
        bindingStore: mockBindingStore as BindingStore,
        relayCore: mockRelayCore,
        agentManager: mockAgentManager,
        meshCore: mockMeshCore,
        relayDir: '/tmp/relay',
        runtimeResolver: mockRuntimeResolver,
      });
      await evictionRouter.init();

      const evictionHandler = (mockRelayCore.subscribe as ReturnType<typeof vi.fn>).mock.calls.at(
        -1
      )?.[1] as typeof capturedHandler;

      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-new',
        adapterId: 'tg-bot',
        agentId: 'agent-a',

        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      // This should trigger eviction of the oldest entry
      await evictionHandler!({
        id: 'msg-new',
        subject: 'relay.human.telegram.tg-bot.new-chat',
        payload: 'hi',
        from: 'tg',
        budget: {
          hopCount: 0,
          maxHops: 5,
          ttl: Date.now() + 60000,
          callBudgetRemaining: 10,
          ancestorChain: [],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      // The session map should still be at MAX_SESSIONS (oldest evicted)
      // Verify by checking that routing to bind-old:chat:0 creates a new session
      // (it was evicted)
      vi.mocked(mockAgentManager.createSession).mockClear();
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-old',
        adapterId: 'tg-bot',
        agentId: 'agent-a',

        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      await evictionHandler!({
        id: 'msg-evicted',
        subject: 'relay.human.telegram.tg-bot.0',
        payload: 'hi',
        from: 'tg',
        budget: {
          hopCount: 0,
          maxHops: 5,
          ttl: Date.now() + 60000,
          callBudgetRemaining: 10,
          ancestorChain: [],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      // Should create a new session because the old entry was evicted
      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(1);

      await evictionRouter.shutdown();
    });
  });

  describe('saveSessionMap error handling', () => {
    it('does not throw when saveSessionMap fails during session creation', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'tg-bot',
        agentId: 'agent-a',

        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      // Mock writeFile to reject — simulates disk full or permission error
      vi.mocked(writeFile).mockRejectedValueOnce(new Error('ENOSPC: no space left'));

      // Should not throw — the session should still be created in memory
      await expect(
        capturedHandler!({
          id: 'msg-1',
          subject: 'relay.human.telegram.tg-bot.123',
          payload: 'hi',
          from: 'tg',
          budget: {
            hopCount: 0,
            maxHops: 5,
            ttl: Date.now() + 60000,
            callBudgetRemaining: 10,
            ancestorChain: [],
          },
          createdAt: '2026-01-01T00:00:00.000Z',
        })
      ).resolves.toBeUndefined();

      // Session was still created and routed successfully
      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(1);
      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        'relay.agent.claude-code.session-abc',
        'hi',
        expect.any(Object)
      );
    });

    it('does not throw when saveSessionMap fails during cleanup', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue({
        id: 'bind-1',
        adapterId: 'tg-bot',
        agentId: 'agent-a',

        sessionStrategy: 'per-chat',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      // Create a session first
      await capturedHandler!({
        id: 'msg-1',
        subject: 'relay.human.telegram.tg-bot.123',
        payload: 'hi',
        from: 'tg',
        budget: {
          hopCount: 0,
          maxHops: 5,
          ttl: Date.now() + 60000,
          callBudgetRemaining: 10,
          ancestorChain: [],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      // Mock writeFile to reject for the cleanup save
      vi.mocked(writeFile).mockRejectedValueOnce(new Error('ENOSPC: no space left'));

      // Should not throw — cleanup should succeed even when persist fails
      await expect(router.cleanupOrphanedSessions(new Set())).resolves.toBe(1);
    });

    it('does not throw when saveSessionMap fails during shutdown', async () => {
      // Mock writeFile to reject
      vi.mocked(writeFile).mockRejectedValueOnce(new Error('ENOSPC: no space left'));

      // Should not throw
      await expect(router.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('permission enforcement', () => {
    const makeEnvelope = (chatId = '123') => ({
      id: 'msg-1',
      subject: `relay.human.telegram.tg-bot.${chatId}`,
      payload: { content: 'hello' },
      from: 'tg',
      budget: {
        hopCount: 0,
        maxHops: 5,
        ttl: Date.now() + 60000,
        callBudgetRemaining: 10,
        ancestorChain: [],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const makeBinding = (overrides: Record<string, unknown> = {}) => ({
      id: 'bind-1',
      adapterId: 'tg-bot',
      agentId: 'agent-a',
      sessionStrategy: 'per-chat',
      label: '',
      permissionMode: 'acceptEdits' as const,
      canInitiate: false,
      canReply: true,
      canReceive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    });

    it('drops inbound messages when canReceive=false', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding({ canReceive: false }));
      await capturedHandler!(makeEnvelope());

      expect(mockRelayCore.publish).not.toHaveBeenCalled();
      expect(mockAgentManager.createSession).not.toHaveBeenCalled();
    });

    it('allows inbound messages when canReceive=true (default)', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding({ canReceive: true }));
      await capturedHandler!(makeEnvelope());

      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        expect.stringContaining('relay.agent.'),
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('includes __bindingPermissions in enriched payload', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(
        makeBinding({ canReply: true, canInitiate: false })
      );
      await capturedHandler!(makeEnvelope());

      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          __bindingPermissions: {
            canReply: true,
            canInitiate: false,
            permissionMode: 'acceptEdits',
          },
        }),
        expect.any(Object)
      );
    });

    it('includes canReply=false in __bindingPermissions when set', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding({ canReply: false }));
      await capturedHandler!(makeEnvelope());

      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          __bindingPermissions: {
            canReply: false,
            canInitiate: false,
            permissionMode: 'acceptEdits',
          },
        }),
        expect.any(Object)
      );
    });

    it('includes canInitiate=true in __bindingPermissions when set', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding({ canInitiate: true }));
      await capturedHandler!(makeEnvelope());

      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          __bindingPermissions: {
            canReply: true,
            canInitiate: true,
            permissionMode: 'acceptEdits',
          },
        }),
        expect.any(Object)
      );
    });

    it('canInitiate=false does not block inbound routing — replies keep flowing (DOR-239)', async () => {
      // canInitiate gates only agent-initiated sends (relay_notify_user, see
      // mcp-relay-notify-tools.test.ts). It must never block inbound delivery
      // — that's what lets the runtime adapter's automatic reply-forwarding
      // keep working on a binding where the human left "Agent can start
      // conversations" unchecked.
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding({ canInitiate: false }));
      await capturedHandler!(makeEnvelope());

      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        expect.stringContaining('relay.agent.'),
        expect.any(Object),
        expect.any(Object)
      );
      expect(mockAgentManager.createSession).toHaveBeenCalled();
    });

    it('does not attach __bindingPermissions to non-object payloads', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding());
      await capturedHandler!({
        ...makeEnvelope(),
        payload: 'plain string',
      });

      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        expect.any(String),
        'plain string',
        expect.any(Object)
      );
    });
  });

  describe('enabled filtering', () => {
    const makeEnvelope = (chatId = '123') => ({
      id: 'msg-1',
      subject: `relay.human.telegram.tg-bot.${chatId}`,
      payload: { content: 'hello' },
      from: 'tg',
      budget: {
        hopCount: 0,
        maxHops: 5,
        ttl: Date.now() + 60000,
        callBudgetRemaining: 10,
        ancestorChain: [],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const makeBinding = (overrides: Record<string, unknown> = {}) => ({
      id: 'bind-1',
      adapterId: 'tg-bot',
      agentId: 'agent-a',
      sessionStrategy: 'per-chat',
      label: '',
      permissionMode: 'acceptEdits' as const,
      enabled: true,
      canInitiate: false,
      canReply: true,
      canReceive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    });

    it('drops inbound messages when binding is paused (enabled=false)', async () => {
      // `resolve()` now filters `enabled` itself (connection-scoping spec
      // §Part 2), so a paused binding is a `resolve()` MISS in production —
      // the router falls back to `resolveIncludingDisabled()` to still tell
      // the person "paused" rather than going silent (DOR-789).
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(undefined);
      vi.mocked(mockBindingStore.resolveIncludingDisabled!).mockReturnValue(
        makeBinding({ enabled: false })
      );
      await capturedHandler!(makeEnvelope());

      expect(mockRelayCore.publish).not.toHaveBeenCalled();
      expect(mockAgentManager.createSession).not.toHaveBeenCalled();
    });

    it('skips paused binding before canReceive check', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(undefined);
      vi.mocked(mockBindingStore.resolveIncludingDisabled!).mockReturnValue(
        makeBinding({ enabled: false, canReceive: true })
      );
      await capturedHandler!(makeEnvelope());

      // Should not reach the publish step — paused takes priority
      expect(mockRelayCore.publish).not.toHaveBeenCalled();
    });

    it('routes normally when binding is enabled (enabled=true)', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding({ enabled: true }));
      await capturedHandler!(makeEnvelope());

      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        expect.stringContaining('relay.agent.'),
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('routes normally when enabled is undefined (defaults to true)', async () => {
      const binding = makeBinding();
      delete (binding as Record<string, unknown>).enabled;
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(binding);
      await capturedHandler!(makeEnvelope());

      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        expect.stringContaining('relay.agent.'),
        expect.any(Object),
        expect.any(Object)
      );
    });
  });

  describe('the interim empty-content gate (DOR-866)', () => {
    // The Telegram adapter now publishes a captionless photo/sticker/voice/
    // document/video/location with `content: ''` and a `platformData.media`
    // descriptor, so a future bridge (task 1.6) can build a placeholder from
    // it. Nothing on the classic/unbridged path reads that descriptor yet —
    // this gate stops that envelope from ever reaching `createSession` /
    // `relayCore.publish`, restoring today's behavior byte-for-byte, while
    // leaving a `bridge: 'room'` binding's envelope untouched for 1.6.

    const makeEnvelope = (content: string, chatId = '123') => ({
      id: 'msg-1',
      subject: `relay.human.telegram.tg-bot.${chatId}`,
      payload: { content, platformData: { media: { type: 'photo' } } },
      from: 'tg',
      budget: {
        hopCount: 0,
        maxHops: 5,
        ttl: Date.now() + 60000,
        callBudgetRemaining: 10,
        ancestorChain: [],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const makeBinding = (overrides: Record<string, unknown> = {}) => ({
      id: 'bind-1',
      adapterId: 'tg-bot',
      agentId: 'agent-a',
      sessionStrategy: 'per-chat',
      label: '',
      permissionMode: 'acceptEdits' as const,
      enabled: true,
      canInitiate: false,
      canReply: true,
      canReceive: true,
      bridge: 'off',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    });

    it('drops a captionless-media envelope on an unbridged binding — no session, no publish to the agent subject', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding());
      const verdict = await capturedHandler!(makeEnvelope(''));

      expect(mockAgentManager.createSession).not.toHaveBeenCalled();
      expect(mockRelayCore.publish).not.toHaveBeenCalled();
      expect(verdict).toEqual({ handled: false, reason: 'no text content' });
    });

    it('drops on a binding that predates the bridge field entirely (bridge undefined, same as off)', async () => {
      const binding = makeBinding();
      delete (binding as Record<string, unknown>).bridge;
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(binding);

      await capturedHandler!(makeEnvelope(''));

      expect(mockRelayCore.publish).not.toHaveBeenCalled();
    });

    it('still routes a normal, non-empty message through the same unbridged binding', async () => {
      // The negative control: proves the gate keys on content emptiness, not
      // on some broader property of the envelope (e.g. the presence of
      // `platformData.media`, which this fixture also carries).
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding());
      await capturedHandler!(makeEnvelope('a real caption'));

      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(1);
      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        expect.stringContaining('relay.agent.'),
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('does NOT drop a captionless-media envelope on a bridged binding — the bridge inherits the unfiltered envelope', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding({ bridge: 'room' }));
      await capturedHandler!(makeEnvelope(''));

      // The terminal ChatBridge.ingest branch (DOR-870) now consumes exactly this
      // envelope — the empty-content gate let it through, and it reached the
      // bridge rather than being dropped. It goes NOWHERE near session dispatch.
      expect(mockBridgeIngest.ingest).toHaveBeenCalledTimes(1);
      expect(mockBridgeIngest.ingest).toHaveBeenCalledWith(
        expect.objectContaining({ bridge: 'room' }),
        expect.objectContaining({ payload: expect.objectContaining({ content: '' }) }),
        expect.objectContaining({ agentPath: expect.any(String) })
      );
      expect(mockAgentManager.createSession).not.toHaveBeenCalled();
      expect(mockRelayCore.publish).not.toHaveBeenCalledWith(
        expect.stringContaining('relay.agent.'),
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('does not gate a payload with no content field at all (not a StandardPayload shape)', async () => {
      // hasEmptyContent only recognizes the exact `content: ''` shape the
      // adapter produces — a payload missing the field entirely must not be
      // swept in by a broader "falsy content" check.
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding());
      const envelope = {
        id: 'msg-1',
        subject: 'relay.human.telegram.tg-bot.123',
        payload: { notContent: 'whatever' },
        from: 'tg',
        budget: {
          hopCount: 0,
          maxHops: 5,
          ttl: Date.now() + 60000,
          callBudgetRemaining: 10,
          ancestorChain: [],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      };

      await capturedHandler!(envelope);

      expect(mockAgentManager.createSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('relay_flow emit (onFlow)', () => {
    // A dedicated router instance with `onFlow` injected — the outer
    // `beforeEach` router omits it, matching production's optional dep.
    let flowRouter: BindingRouter;
    let flowRelayCore: RelayCoreLike;
    let onFlow: ReturnType<typeof vi.fn>;
    let flowHandler: ((envelope: Record<string, unknown>) => Promise<void>) | undefined;

    const makeBinding = (overrides: Record<string, unknown> = {}) => ({
      id: 'bind-1',
      adapterId: 'tg-bot',
      agentId: 'agent-a',
      sessionStrategy: 'per-chat' as const,
      label: '',
      permissionMode: 'acceptEdits' as const,
      enabled: true,
      canInitiate: false,
      canReply: true,
      canReceive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    });

    const makeEnvelope = (overrides: Record<string, unknown> = {}) => ({
      id: 'msg-1',
      subject: 'relay.human.telegram.tg-bot.123',
      payload: { content: 'hello' },
      from: 'relay.human.telegram.bot',
      budget: {
        hopCount: 0,
        maxHops: 5,
        ttl: Date.now() + 60000,
        callBudgetRemaining: 10,
        ancestorChain: [],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    });

    beforeEach(async () => {
      onFlow = vi.fn();
      flowRelayCore = {
        publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
        subscribe: vi.fn((_pattern: string, handler: unknown) => {
          flowHandler = handler as typeof flowHandler;
          return mockUnsubscribe;
        }),
      };
      flowRouter = new BindingRouter({
        resolveCwd: fakeResolveCwd,
        bindingStore: mockBindingStore as BindingStore,
        relayCore: flowRelayCore,
        agentManager: mockAgentManager,
        meshCore: mockMeshCore,
        relayDir: '/tmp/relay-flow',
        runtimeResolver: mockRuntimeResolver,
        onFlow,
      });
      await flowRouter.init();
    });

    afterEach(async () => {
      await flowRouter.shutdown();
    });

    it('fires onFlow exactly once with the routing skeleton when deliveredTo > 0', async () => {
      // Purpose: a delivered inbound message pulses, keyed by the binding's
      // own join keys (bindingId/adapterId/agentId), inbound direction, ISO at.
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding());
      vi.mocked(flowRelayCore.publish).mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 });

      await flowHandler!(makeEnvelope());

      expect(onFlow).toHaveBeenCalledTimes(1);
      expect(onFlow).toHaveBeenCalledWith({
        bindingId: 'bind-1',
        adapterId: 'tg-bot',
        agentId: 'agent-a',
        direction: 'inbound',
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
      });
    });

    it('does not fire onFlow when deliveredTo === 0 (budget/consent/unsubscribed)', async () => {
      // Purpose: the honesty gate — a rejected or unsubscribed message never
      // reached the agent and must not pulse.
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding());
      vi.mocked(flowRelayCore.publish).mockResolvedValue({ messageId: 'msg-2', deliveredTo: 0 });

      await flowHandler!(makeEnvelope());

      expect(onFlow).not.toHaveBeenCalled();
    });

    it('does not fire onFlow for agent-originated envelopes (feedback-loop guard)', async () => {
      // Purpose: no phantom pulse on non-routed inbound — skipped before
      // binding resolution even runs.
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding());

      await flowHandler!(makeEnvelope({ from: 'agent:session-abc' }));

      expect(onFlow).not.toHaveBeenCalled();
      expect(flowRelayCore.publish).not.toHaveBeenCalled();
    });

    it('does not fire onFlow when no binding resolves', async () => {
      // Purpose: no phantom pulse when there is no binding to key the edge on.
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(undefined);

      await flowHandler!(makeEnvelope());

      expect(onFlow).not.toHaveBeenCalled();
    });

    it('does not fire onFlow for a paused (enabled=false) or canReceive=false binding', async () => {
      // Purpose: no phantom pulse when routing itself is suppressed.
      // `resolve()` filters `enabled` (§Part 2), so a paused binding is a
      // MISS there — the router's `resolveIncludingDisabled` fallback is
      // what still surfaces it, with no pulse either way.
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(undefined);
      vi.mocked(mockBindingStore.resolveIncludingDisabled!).mockReturnValue(
        makeBinding({ enabled: false })
      );
      await flowHandler!(makeEnvelope());
      expect(onFlow).not.toHaveBeenCalled();

      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding({ canReceive: false }));
      await flowHandler!(makeEnvelope());
      expect(onFlow).not.toHaveBeenCalled();
    });
  });

  describe('testBinding()', () => {
    const makeBinding = (overrides: Record<string, unknown> = {}) => ({
      id: 'bind-1',
      adapterId: 'tg-bot',
      agentId: 'agent-a',
      sessionStrategy: 'per-chat' as const,
      label: '',
      permissionMode: 'acceptEdits' as const,
      enabled: true,
      canInitiate: false,
      canReply: true,
      canReceive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    });

    it('returns ok=false when binding is not found', () => {
      vi.mocked(mockBindingStore.getById!).mockReturnValue(undefined);

      const result = router.testBinding('nonexistent');

      expect(result.ok).toBe(false);
      expect(result.resolved).toBe(false);
      expect(result.reason).toBe('Binding not found');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('returns ok=false when binding is paused', () => {
      vi.mocked(mockBindingStore.getById!).mockReturnValue(makeBinding({ enabled: false }));

      const result = router.testBinding('bind-1');

      expect(result.ok).toBe(false);
      expect(result.resolved).toBe(false);
      expect(result.reason).toBe('Binding is paused (enabled=false)');
    });

    it('returns ok=false when agent is not in mesh registry', () => {
      vi.mocked(mockBindingStore.getById!).mockReturnValue(makeBinding());
      vi.mocked(mockMeshCore.getProjectPath).mockReturnValue(undefined);

      const result = router.testBinding('bind-1');

      expect(result.ok).toBe(false);
      expect(result.resolved).toBe(false);
      expect(result.reason).toContain('agent-a');
      expect(result.reason).toContain('not found in mesh registry');
    });

    it('returns ok=true with agent ID when routing succeeds', () => {
      vi.mocked(mockBindingStore.getById!).mockReturnValue(makeBinding());
      vi.mocked(mockMeshCore.getProjectPath).mockReturnValue(AGENT_PATH);

      const result = router.testBinding('bind-1');

      expect(result.ok).toBe(true);
      expect(result.resolved).toBe(true);
      expect(result.wouldDeliverTo).toBe('agent-a');
      expect(result.details).toBe('Routing succeeded. No agent was invoked.');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('does not invoke the agent or publish to relay', () => {
      vi.mocked(mockBindingStore.getById!).mockReturnValue(makeBinding());
      vi.mocked(mockMeshCore.getProjectPath).mockReturnValue(AGENT_PATH);

      router.testBinding('bind-1');

      expect(mockRelayCore.publish).not.toHaveBeenCalled();
      expect(mockAgentManager.createSession).not.toHaveBeenCalled();
    });
  });

  describe('shutdown()', () => {
    it('calls unsubscribe on shutdown', async () => {
      await router.shutdown();
      expect(mockUnsubscribe).toHaveBeenCalled();
    });

    it('saves session map on shutdown', async () => {
      vi.mocked(writeFile).mockClear();
      vi.mocked(rename).mockClear();
      await router.shutdown();
      expect(writeFile).toHaveBeenCalled();
    });
  });

  describe('runtime-neutral dispatch', () => {
    const makeBinding = () => ({
      id: 'bind-1',
      adapterId: 'tg-bot',
      agentId: 'agent-a',
      sessionStrategy: 'per-chat' as const,
      label: '',
      permissionMode: 'acceptEdits' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const makeEnvelope = (chatId = '123') => ({
      id: 'msg-1',
      subject: `relay.human.telegram.tg-bot.${chatId}`,
      payload: { text: 'hello' },
      from: 'tg',
      budget: {
        hopCount: 0,
        maxHops: 5,
        ttl: Date.now() + 60000,
        callBudgetRemaining: 10,
        ancestorChain: [],
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    it('publishes on relay.agent.claude-code.* for claude-code-owned sessions', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding());
      vi.mocked(mockRuntimeResolver.getSessionRuntimeType).mockResolvedValue('claude-code');

      await capturedHandler!(makeEnvelope('chat-cc'));

      expect(mockRuntimeResolver.getSessionRuntimeType).toHaveBeenCalledWith('session-abc');
      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        'relay.agent.claude-code.session-abc',
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('publishes on relay.agent.test-mode.* for test-mode-owned sessions', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding());
      vi.mocked(mockAgentManager.createSession).mockResolvedValue({ id: 'session-test' });
      vi.mocked(mockRuntimeResolver.getSessionRuntimeType).mockResolvedValue('test-mode');

      await capturedHandler!(makeEnvelope('chat-test'));

      expect(mockRuntimeResolver.getSessionRuntimeType).toHaveBeenCalledWith('session-test');
      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        'relay.agent.test-mode.session-test',
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('falls back to relay.agent.<sessionId> when no runtimeResolver is provided', async () => {
      const legacyPublish = vi.fn().mockResolvedValue({ messageId: 'msg', deliveredTo: 1 });
      let legacyHandler: ((envelope: Record<string, unknown>) => Promise<void>) | undefined;
      const legacyRelayCore: RelayCoreLike = {
        publish: legacyPublish,
        subscribe: vi.fn((_pattern: string, handler: unknown) => {
          legacyHandler = handler as typeof legacyHandler;
          return mockUnsubscribe;
        }),
      };
      const legacyRouter = new BindingRouter({
        resolveCwd: fakeResolveCwd,
        bindingStore: mockBindingStore as BindingStore,
        relayCore: legacyRelayCore,
        agentManager: mockAgentManager,
        meshCore: mockMeshCore,
        relayDir: '/tmp/relay',
        // runtimeResolver intentionally omitted
      });
      await legacyRouter.init();

      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding());
      await legacyHandler!(makeEnvelope('legacy'));

      expect(legacyPublish).toHaveBeenCalledWith(
        'relay.agent.session-abc',
        expect.any(Object),
        expect.any(Object)
      );
      expect(mockRuntimeResolver.getSessionRuntimeType).not.toHaveBeenCalled();

      await legacyRouter.shutdown();
    });

    it('falls back to legacy subject when runtime lookup throws', async () => {
      vi.mocked(mockBindingStore.resolve!).mockReturnValue(makeBinding());
      vi.mocked(mockRuntimeResolver.getSessionRuntimeType).mockRejectedValue(
        new Error('db offline')
      );

      await capturedHandler!(makeEnvelope('chat-err'));

      expect(mockRelayCore.publish).toHaveBeenCalledWith(
        'relay.agent.session-abc',
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('has no instanceof ClaudeCodeAdapter or runtime-identity branches in dispatch', () => {
      // Static guard: the module source must not reference the adapter class
      // by name, and must not special-case `runtimeType === 'claude-code'`.
      const thisFileUrl = import.meta.url;
      const moduleUrl = new URL('../binding-router.ts', thisFileUrl);
      const src = readFileSync(fileURLToPath(moduleUrl), 'utf8');
      expect(src).not.toMatch(/instanceof\s+ClaudeCodeAdapter/);
      expect(src).not.toMatch(/runtimeType\s*===\s*['"]claude-code['"]/);
    });
  });

  describe('claim feed (connection-scoping spec §Part 3)', () => {
    // A dedicated router instance wired with a REAL UnclaimedChatStore (an
    // in-memory db) — the invariants under test (damping, block, no body
    // leak) live in how the router calls the store, so a real store is what
    // makes the assertions honest.
    let claimRouter: BindingRouter;
    let claimRelayCore: RelayCoreLike;
    let claimStore: import('../unclaimed-chat-store.js').UnclaimedChatStore;
    let onUnclaimedChat: ReturnType<typeof vi.fn>;
    let onUnclaimedChatBurst: ReturnType<typeof vi.fn>;
    let claimHandler: ((envelope: Record<string, unknown>) => Promise<void>) | undefined;
    let claimBindingStore: Partial<BindingStore>;
    let claimMeshCore: AdapterMeshCoreLike;

    const BODY_SENTINEL = 'THE-MESSAGE-BODY-MUST-NEVER-APPEAR-IN-THE-CLAIM-FEED';

    /** A distinct unbound envelope per chatId, so each is its own "first sighting." */
    function unboundEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        id: 'msg-1',
        subject: 'relay.human.telegram.tg-bot.999',
        payload: { content: BODY_SENTINEL, senderName: 'Miguel', platformData: { fromId: 42 } },
        from: 'tg',
        budget: {
          hopCount: 0,
          maxHops: 5,
          ttl: Date.now() + 60000,
          callBudgetRemaining: 10,
          ancestorChain: [],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
      };
    }

    beforeEach(async () => {
      const { createDb, runMigrations } = await import('@dorkos/db');
      const { UnclaimedChatStore } = await import('../unclaimed-chat-store.js');
      const db = createDb(':memory:');
      runMigrations(db);
      claimStore = new UnclaimedChatStore(db);
      onUnclaimedChat = vi.fn();
      onUnclaimedChatBurst = vi.fn();

      claimBindingStore = {
        resolve: vi.fn().mockReturnValue(undefined),
        resolveIncludingDisabled: vi.fn().mockReturnValue(undefined),
        getById: vi.fn(),
      };
      claimRelayCore = {
        publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
        subscribe: vi.fn((_pattern: string, handler: unknown) => {
          claimHandler = handler as typeof claimHandler;
          return mockUnsubscribe;
        }),
      };
      const claimAgentManager: AgentSessionCreator = {
        createSession: vi.fn().mockResolvedValue({ id: 'session-x' }),
      };
      claimMeshCore = { getProjectPath: vi.fn() };

      claimRouter = new BindingRouter({
        resolveCwd: fakeResolveCwd,
        bindingStore: claimBindingStore as BindingStore,
        relayCore: claimRelayCore,
        agentManager: claimAgentManager,
        meshCore: claimMeshCore,
        relayDir: '/tmp/relay-claim',
        unclaimedChats: claimStore,
        onUnclaimedChat,
        onUnclaimedChatBurst,
      });
      await claimRouter.init();
    });

    afterEach(async () => {
      await claimRouter.shutdown();
    });

    it('AC3.1/AC7.7 no-turn: an unbound inbound message records a claim card, fires the event once, and never starts a turn', async () => {
      await claimHandler!(unboundEnvelope());

      expect(claimStore.list('pending')).toHaveLength(1);
      expect(onUnclaimedChat).toHaveBeenCalledTimes(1);
      expect(onUnclaimedChat).toHaveBeenCalledWith(
        expect.objectContaining({ adapterId: 'tg-bot', chatId: '999', senderName: 'Miguel' })
      );

      // The no-turn invariant: nothing that would run an agent was called.
      expect(claimBindingStore.resolve).toHaveBeenCalled();
      const agentManager = (
        claimRouter as unknown as { deps: { agentManager: AgentSessionCreator } }
      ).deps.agentManager;
      expect(agentManager.createSession).not.toHaveBeenCalled();
      expect(claimRelayCore.publish).not.toHaveBeenCalled();
    });

    it('AC3.2: damping — a second unbound message on the same chat bumps the counter and does not fire the event again', async () => {
      await claimHandler!(unboundEnvelope());
      await claimHandler!(unboundEnvelope());

      expect(claimStore.list('pending')).toHaveLength(1);
      expect(claimStore.list('pending')[0]!.messageCount).toBe(2);
      expect(onUnclaimedChat).toHaveBeenCalledTimes(1);
    });

    it('AC3.3: the persisted row and the broadcast payload never contain the message body', async () => {
      await claimHandler!(unboundEnvelope());

      const row = claimStore.list('pending')[0]!;
      expect(JSON.stringify(row)).not.toContain(BODY_SENTINEL);

      const broadcast = onUnclaimedChat.mock.calls[0]![0];
      expect(JSON.stringify(broadcast)).not.toContain(BODY_SENTINEL);
    });

    // DOR-907: the raw platform chat type on `platformData.chatType` flows all
    // the way from the inbound payload into the persisted sighting, kept
    // distinct from the folded `chatKind`. A folded broadcast (a `channel` that
    // reaches us on a group subject) is now recorded AS a broadcast, which is
    // what a later claim carries onto the binding to refuse it precisely.
    it('DOR-907: threads platformData.chatType into the sighting, distinct from the folded chatKind', async () => {
      await claimHandler!(
        unboundEnvelope({
          subject: 'relay.human.telegram.tg-bot.group.555',
          payload: {
            content: BODY_SENTINEL,
            senderName: 'Ana',
            platformData: { fromId: 7, chatType: 'channel' },
          },
        })
      );

      const row = claimStore.list('pending').find((c) => c.chatId === '555')!;
      expect(row).toBeDefined();
      // Folded to a coarse `group` for routing...
      expect(row.chatKind).toBe('group');
      // ...but the RAW type survived as `channel` — the whole point of DOR-907.
      expect(row.platformChatType).toBe('channel');
    });

    it('DOR-907: a real group sighting records platformChatType supergroup', async () => {
      await claimHandler!(
        unboundEnvelope({
          subject: 'relay.human.telegram.tg-bot.group.556',
          payload: { content: BODY_SENTINEL, platformData: { fromId: 8, chatType: 'supergroup' } },
        })
      );
      const row = claimStore.list('pending').find((c) => c.chatId === '556')!;
      expect(row.platformChatType).toBe('supergroup');
    });

    it('DOR-907: a DM sighting with no chatType in the payload records platformChatType null', async () => {
      await claimHandler!(unboundEnvelope());
      const row = claimStore.list('pending').find((c) => c.chatId === '999')!;
      expect(row.platformChatType).toBeNull();
    });

    // DOR-883: the group-add claim flow's entry point publishes through this
    // SAME unbound-chat path (`chat-member.ts`'s module doc explains why) —
    // `content: ''`, no `platformData.messageId`, and `senderName` set to the
    // ADDER's name rather than a message author's. This is that envelope,
    // proving the claim feed shows the right person without any change to
    // the router itself.
    it('DOR-883: a group-add event (no messageId, empty content) still records ONE sighting naming the adder and the group', async () => {
      await claimHandler!(
        unboundEnvelope({
          subject: 'relay.human.telegram.tg-bot.group.888',
          payload: {
            content: '',
            senderName: 'Ana',
            channelName: 'Release train',
            platformData: { fromId: 42, chatType: 'supergroup' },
          },
        })
      );

      const row = claimStore.list('pending').find((c) => c.chatId === '888')!;
      expect(row).toBeDefined();
      expect(row.senderName).toBe('Ana');
      expect(row.chatTitle).toBe('Release train');
      expect(row.chatKind).toBe('group');
      expect(row.platformChatType).toBe('supergroup');
      expect(onUnclaimedChat).toHaveBeenCalledTimes(1);
      // No turn, same as every other unbound sighting.
      const agentManager = (
        claimRouter as unknown as { deps: { agentManager: AgentSessionCreator } }
      ).deps.agentManager;
      expect(agentManager.createSession).not.toHaveBeenCalled();
    });

    it('block short-circuits before any store write — recordless from that point on', async () => {
      await claimHandler!(unboundEnvelope());
      const chat = claimStore.list('pending')[0]!;
      claimStore.block(chat.id);

      const before = claimStore.getById(chat.id)!;
      await claimHandler!(unboundEnvelope());
      const after = claimStore.getById(chat.id)!;

      // No second event, and the row's counters are byte-identical — proving
      // the router never touched the store on the blocked path.
      expect(onUnclaimedChat).toHaveBeenCalledTimes(1); // only the original sighting
      expect(after).toEqual(before);
    });

    it('a message from an unknown chatId subject (adapter-root) does not throw and does not write a row', async () => {
      await claimHandler!(unboundEnvelope({ subject: 'relay.human.telegram.tg-bot' }));
      expect(claimStore.list('pending')).toHaveLength(0);
    });

    it('MAJOR 5: a blocked chat that later got a manual, enabled binding routes normally — the binding wins, isBlocked is never even consulted', async () => {
      await claimHandler!(unboundEnvelope());
      const chat = claimStore.list('pending')[0]!;
      claimStore.block(chat.id);
      expect(claimStore.isBlocked('tg-bot', '999')).toBe(true);

      // A person manually creates a binding for this exact chat afterward.
      vi.mocked(claimMeshCore.getProjectPath).mockReturnValue(AGENT_PATH);
      vi.mocked(claimBindingStore.resolve!).mockReturnValue({
        id: 'bind-manual',
        adapterId: 'tg-bot',
        agentId: 'agent-a',
        chatId: '999',
        sessionStrategy: 'per-chat',
        label: '',
        permissionMode: 'acceptEdits',
        enabled: true,
        canInitiate: false,
        canReply: true,
        canReceive: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      const isBlockedSpy = vi.spyOn(claimStore, 'isBlocked');

      await claimHandler!(unboundEnvelope());

      // Routed: publish was called (a session was resolved/created for it).
      const agentManager = (
        claimRouter as unknown as { deps: { agentManager: AgentSessionCreator } }
      ).deps.agentManager;
      expect(agentManager.createSession).toHaveBeenCalled();
      expect(claimRelayCore.publish).toHaveBeenCalled();
      // The block state was never even checked — resolve() finding a binding
      // short-circuits before the blocked branch is reached at all.
      expect(isBlockedSpy).not.toHaveBeenCalled();
    });

    it('is a no-op (never throws) when unclaimedChats is not wired', async () => {
      const bareRouter = new BindingRouter({
        resolveCwd: fakeResolveCwd,
        bindingStore: claimBindingStore as BindingStore,
        relayCore: claimRelayCore,
        agentManager: { createSession: vi.fn() },
        meshCore: { getProjectPath: vi.fn() },
        relayDir: '/tmp/relay-claim-bare',
      });
      let bareHandler: ((envelope: Record<string, unknown>) => Promise<void>) | undefined;
      claimRelayCore.subscribe = vi.fn((_pattern: string, handler: unknown) => {
        bareHandler = handler as typeof bareHandler;
        return mockUnsubscribe;
      });
      await bareRouter.init();
      let threw: unknown;
      try {
        await bareHandler!(unboundEnvelope());
      } catch (err) {
        threw = err;
      }
      expect(threw).toBeUndefined();
      await bareRouter.shutdown();
    });

    it('MAJOR 4: rate-limits broadcasts across DIFFERENT chats — caps individual events per window and fires one summary', async () => {
      // 25 distinct first-sighting chats in one burst; the cap is 20/window.
      for (let i = 0; i < 25; i++) {
        await claimHandler!(unboundEnvelope({ subject: `relay.human.telegram.tg-bot.chat-${i}` }));
      }

      expect(onUnclaimedChat).toHaveBeenCalledTimes(20);
      expect(onUnclaimedChatBurst).toHaveBeenCalledTimes(1);
      expect(onUnclaimedChatBurst).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
      // Every chat is still recorded durably — only the BROADCAST is capped,
      // never the recording (the claim feed itself has its own cap, MAJOR 4's
      // other half, tested in unclaimed-chat-store.test.ts).
      expect(claimStore.list('pending')).toHaveLength(25);

      // A second burst past the summary does not re-fire it within the SAME window.
      await claimHandler!(unboundEnvelope({ subject: 'relay.human.telegram.tg-bot.chat-extra' }));
      expect(onUnclaimedChatBurst).toHaveBeenCalledTimes(1);
    });
  });
});
