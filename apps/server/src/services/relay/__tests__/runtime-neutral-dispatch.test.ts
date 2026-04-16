/**
 * Integration guard: binding-router → per-runtime subject dispatch.
 *
 * Proves that the subject shape emitted by BindingRouter (new runtime-scoped
 * `relay.agent.<runtimeType>.<sessionId>`) round-trips through the shared
 * `parseAgentSubject` helper to the right adapter. Uses lightweight fake
 * RelayAdapter instances so the test stays focused on the routing contract,
 * not on the full Claude-Code / test-mode runtime surfaces.
 *
 * This test lives alongside `binding-router.test.ts` (which covers subject
 * shape in isolation) — here we verify that the shape the router emits is
 * actually matched by the `AdapterRegistry.getBySubject` prefix matcher.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RelayAdapter } from '@dorkos/relay';
import { AdapterRegistry, extractSessionIdFromSubject } from '@dorkos/relay';
import {
  BindingRouter,
  type RelayCoreLike,
  type AgentSessionCreator,
  type RuntimeTypeResolver,
} from '../binding-router.js';
import type { BindingStore } from '../binding-store.js';
import type { AdapterMeshCoreLike } from '../adapter-manager.js';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';

vi.mock('node:fs/promises');

interface FakeAdapter extends RelayAdapter {
  readonly delivered: Array<{ subject: string; sessionId: string | null }>;
}

function createFakeAdapter(id: string, subjectPrefix: string | string[]): FakeAdapter {
  const delivered: Array<{ subject: string; sessionId: string | null }> = [];
  const adapter: FakeAdapter = {
    id,
    subjectPrefix: Array.isArray(subjectPrefix) ? subjectPrefix : [subjectPrefix],
    displayName: id,
    delivered,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({
      state: 'connected',
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
    }),
    deliver: vi.fn(async (subject: string) => {
      delivered.push({ subject, sessionId: extractSessionIdFromSubject(subject) });
      return { success: true, durationMs: 0 };
    }),
  } as unknown as FakeAdapter;
  return adapter;
}

describe('runtime-neutral dispatch (binding-router + adapter-registry)', () => {
  const CLAUDE_SESSION_ID = 'cc-session-uuid-0000-0000-000000000001';
  const TESTMODE_SESSION_ID = 'tm-session-uuid-0000-0000-000000000002';

  let router: BindingRouter;
  let mockRelayCore: RelayCoreLike;
  let mockAgentManager: AgentSessionCreator;
  let mockMeshCore: AdapterMeshCoreLike;
  let mockBindingStore: Partial<BindingStore>;
  let mockRuntimeResolver: RuntimeTypeResolver;
  let capturedHandler: ((envelope: Record<string, unknown>) => Promise<void>) | undefined;
  let registry: AdapterRegistry;
  let claudeAdapter: FakeAdapter;
  let testModeAdapter: FakeAdapter;

  beforeEach(async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue();
    vi.mocked(rename).mockResolvedValue();

    // Adapter registry is populated with two adapters: the test-mode wrapper
    // is registered FIRST with the more-specific prefix so it wins over the
    // claude-code adapter's legacy catch-all prefix (`relay.agent.`).
    registry = new AdapterRegistry();
    registry.setRelay({
      publish: vi.fn().mockResolvedValue({ messageId: 'msg', deliveredTo: 0 }),
      subscribe: vi.fn().mockReturnValue(vi.fn()),
      onSignal: vi.fn().mockReturnValue(vi.fn()),
    });
    testModeAdapter = createFakeAdapter('test-mode', ['relay.agent.test-mode.']);
    claudeAdapter = createFakeAdapter('claude-code', ['relay.agent.claude-code.', 'relay.agent.']);
    // Registration order deliberately puts the catch-all prefix adapter FIRST.
    // With longest-prefix-wins matching (see `AdapterRegistry.getBySubject`)
    // this must still route `relay.agent.test-mode.*` to the test-mode adapter,
    // because `'relay.agent.test-mode.'` is a longer prefix match than
    // `'relay.agent.'`. If this ever regresses, the router becomes silently
    // order-dependent.
    await registry.register(claudeAdapter);
    await registry.register(testModeAdapter);

    capturedHandler = undefined;
    mockRelayCore = {
      publish: vi.fn(async (subject: string, _payload: unknown, _opts: unknown) => {
        // Route the published subject through the registry, mirroring what
        // the real RelayCore does. We do not exercise Maildir / endpoints
        // here — this is a routing-contract test.
        const adapter = registry.getBySubject(subject);
        if (adapter) {
          await adapter.deliver(
            subject,
            {
              id: 'test',
              subject,
              from: 'test',
              payload: {},
              budget: {
                hopCount: 0,
                maxHops: 5,
                ttl: Date.now() + 60000,
                callBudgetRemaining: 10,
                ancestorChain: [],
              },
              createdAt: new Date().toISOString(),
            } as never,
            undefined
          );
        }
        return { messageId: 'msg', deliveredTo: adapter ? 1 : 0 };
      }),
      subscribe: vi.fn((_pattern: string, handler: unknown) => {
        capturedHandler = handler as typeof capturedHandler;
        return vi.fn();
      }),
    };

    mockAgentManager = {
      createSession: vi.fn().mockResolvedValue({ id: CLAUDE_SESSION_ID }),
    };
    mockMeshCore = {
      getProjectPath: vi.fn().mockReturnValue('/agents/a'),
    };
    mockBindingStore = {
      resolve: vi.fn().mockReturnValue({
        id: 'bind-1',
        adapterId: 'tg-bot',
        agentId: 'agent-a',
        sessionStrategy: 'per-chat',
        permissionMode: 'acceptEdits',
        label: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    };
    // Resolver returns different runtime types depending on which session
    // the router asks about — simulates the consolidated DB lookup.
    mockRuntimeResolver = {
      getSessionRuntimeType: vi.fn(async (sessionId: string) => {
        if (sessionId === TESTMODE_SESSION_ID) return 'test-mode';
        return 'claude-code';
      }),
    };

    router = new BindingRouter({
      bindingStore: mockBindingStore as BindingStore,
      relayCore: mockRelayCore,
      agentManager: mockAgentManager,
      meshCore: mockMeshCore,
      relayDir: '/tmp/relay',
      runtimeResolver: mockRuntimeResolver,
    });
    await router.init();
  });

  const makeEnvelope = (chatId: string) =>
    ({
      id: `msg-${chatId}`,
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
    }) as unknown as Record<string, unknown>;

  it('routes a claude-code session through the claude-code adapter', async () => {
    vi.mocked(mockAgentManager.createSession).mockResolvedValue({ id: CLAUDE_SESSION_ID });
    await capturedHandler!(makeEnvelope('chat-cc'));

    expect(claudeAdapter.delivered).toHaveLength(1);
    expect(claudeAdapter.delivered[0].subject).toBe(`relay.agent.claude-code.${CLAUDE_SESSION_ID}`);
    expect(claudeAdapter.delivered[0].sessionId).toBe(CLAUDE_SESSION_ID);
    expect(testModeAdapter.delivered).toHaveLength(0);
  });

  it('routes a test-mode session through the test-mode adapter', async () => {
    vi.mocked(mockAgentManager.createSession).mockResolvedValue({ id: TESTMODE_SESSION_ID });
    await capturedHandler!(makeEnvelope('chat-tm'));

    expect(testModeAdapter.delivered).toHaveLength(1);
    expect(testModeAdapter.delivered[0].subject).toBe(
      `relay.agent.test-mode.${TESTMODE_SESSION_ID}`
    );
    expect(testModeAdapter.delivered[0].sessionId).toBe(TESTMODE_SESSION_ID);
    expect(claudeAdapter.delivered).toHaveLength(0);
  });

  it('routes legacy (fallback) subjects through the claude-code adapter', async () => {
    // Simulate a resolver-throw path: the router falls back to the legacy
    // 3-part subject shape, which must still land on the claude-code adapter
    // via its retained legacy prefix.
    vi.mocked(mockRuntimeResolver.getSessionRuntimeType).mockRejectedValueOnce(
      new Error('db offline')
    );
    vi.mocked(mockAgentManager.createSession).mockResolvedValue({ id: CLAUDE_SESSION_ID });
    await capturedHandler!(makeEnvelope('chat-legacy'));

    expect(claudeAdapter.delivered).toHaveLength(1);
    expect(claudeAdapter.delivered[0].subject).toBe(`relay.agent.${CLAUDE_SESSION_ID}`);
    expect(claudeAdapter.delivered[0].sessionId).toBe(CLAUDE_SESSION_ID);
    expect(testModeAdapter.delivered).toHaveLength(0);
  });
});
