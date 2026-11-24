/**
 * The subject BindingRouter emits (`relay.agent.<runtimeType>.<sessionId>`)
 * reaches the right adapter through `AdapterRegistry.getBySubject`, whose
 * longest-prefix match must not depend on registration order.
 */
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import type { RelayAdapter } from '@dorkos/relay';
import type { PermissionMode } from '@dorkos/shared/schemas';
import { AdapterRegistry } from '@dorkos/relay';
import { BindingRouter } from '../binding-router.js';
import type { BindingStore } from '../binding-store.js';
import { readFile } from 'node:fs/promises';

vi.mock('node:fs/promises');

const CC_ID = 'cc-session-uuid-0000-0000-000000000001';
const TM_ID = 'tm-session-uuid-0000-0000-000000000002';

/** An adapter that records each subject delivered to it. */
function fakeAdapter(id: string, subjectPrefix: string[]) {
  const delivered: string[] = [];
  const adapter = {
    id,
    subjectPrefix,
    displayName: id,
    start: vi.fn(),
    stop: vi.fn(),
    getStatus: vi.fn(() => ({
      state: 'connected',
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
    })),
    deliver: vi.fn(async (subject: string) => {
      delivered.push(subject);
      return { success: true, durationMs: 0 };
    }),
  } as unknown as RelayAdapter;
  return { adapter, delivered };
}

describe('runtime-neutral dispatch (binding-router + adapter-registry)', () => {
  let claude: ReturnType<typeof fakeAdapter>;
  let testMode: ReturnType<typeof fakeAdapter>;
  let handler: (envelope: Record<string, unknown>) => Promise<void>;
  let createSession: Mock<
    (cwd: string, mode: PermissionMode, agentPath: string) => Promise<{ id: string }>
  >;
  let getSessionRuntimeType: Mock<(sessionId: string) => Promise<string>>;

  beforeEach(async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    const registry = new AdapterRegistry();
    registry.setRelay({ publish: vi.fn(), subscribe: vi.fn(), onSignal: vi.fn() } as never);
    claude = fakeAdapter('claude-code', ['relay.agent.claude-code.', 'relay.agent.']);
    testMode = fakeAdapter('test-mode', ['relay.agent.test-mode.']);
    // The catch-all prefix registers FIRST; the longer prefix must still win.
    await registry.register(claude.adapter);
    await registry.register(testMode.adapter);
    createSession = vi.fn();
    getSessionRuntimeType = vi.fn(async (id: string) =>
      id === TM_ID ? 'test-mode' : 'claude-code'
    );
    const router = new BindingRouter({
      bindingStore: {
        resolve: () => ({
          id: 'bind-1',
          adapterId: 'tg-bot',
          agentId: 'agent-a',
          sessionStrategy: 'per-chat',
        }),
      } as unknown as BindingStore,
      relayCore: {
        publish: async (subject: string) => {
          await registry.getBySubject(subject)?.deliver(subject, {} as never, undefined);
          return { messageId: 'msg', deliveredTo: 1 };
        },
        subscribe: vi.fn((_pattern: string, h: unknown) => {
          handler = h as typeof handler;
          return vi.fn();
        }),
      },
      agentManager: { createSession },
      meshCore: { getProjectPath: () => '/agents/a' },
      relayDir: '/tmp/relay',
      runtimeResolver: { getSessionRuntimeType },
    });
    await router.init();
  });

  it.each([
    [
      'a claude-code session to the claude-code adapter',
      CC_ID,
      false,
      'claude',
      `relay.agent.claude-code.${CC_ID}`,
    ],
    [
      'a test-mode session to the test-mode adapter',
      TM_ID,
      false,
      'testMode',
      `relay.agent.test-mode.${TM_ID}`,
    ],
    // A resolver failure falls back to the legacy subject, kept on claude-code.
    [
      'a legacy fallback subject to the claude-code adapter',
      CC_ID,
      true,
      'claude',
      `relay.agent.${CC_ID}`,
    ],
  ] as const)('routes %s', async (_label, sessionId, resolverFails, winner, subject) => {
    createSession.mockResolvedValue({ id: sessionId });
    if (resolverFails) getSessionRuntimeType.mockRejectedValueOnce(new Error('db offline'));
    await handler({
      id: 'msg-1',
      subject: 'relay.human.telegram.tg-bot.chat',
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
    const [hit, miss] = winner === 'claude' ? [claude, testMode] : [testMode, claude];
    expect(hit.delivered).toEqual([subject]);
    expect(miss.delivered).toEqual([]);
  });
});
