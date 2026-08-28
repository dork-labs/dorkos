/**
 * `BindingRouter` routes a `bridge: 'room'` binding to `ChatBridge.ingest` and
 * NOWHERE else (chats-as-channels spec §5.1, A2.1/A5.2, A7.3).
 *
 * The point of these tests is what does NOT happen: a bridged inbound message
 * must never reach session dispatch, because `ingest` is terminal and falling
 * through would run the turn twice from one message. Every "did not happen" is
 * observed on the real seam the spec names — a SPY on the `AgentSessionCreator`
 * for A2.1/A5.2, and the router's own session map for A7.3 — not by reading code
 * order.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import {
  BindingRouter,
  type RelayCoreLike,
  type AgentSessionCreator,
  type RuntimeTypeResolver,
} from '../binding-router.js';
import type { BindingStore } from '../binding-store.js';
import type { AdapterMeshCoreLike } from '../adapter-manager.js';
import type { ChatBridgeIngest, IngestResult } from '../chat-bridge/index.js';

vi.mock('node:fs/promises');

/** A resolved binding with the bridge on, as `bindingStore.resolve` returns it. */
function bridgedBinding() {
  return {
    id: 'bind-bridged',
    adapterId: 'tg-bot',
    chatId: '123',
    agentId: 'agent-a',
    enabled: true,
    canReceive: true,
    canReply: true,
    canInitiate: false,
    notifyOnTaskComplete: false,
    permissionMode: 'default' as const,
    sessionStrategy: 'per-chat' as const,
    bridge: 'room' as const,
    roomId: 'room-1',
    label: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function inboundEnvelope() {
  return {
    id: 'msg-1',
    subject: 'relay.human.telegram.tg-bot.123',
    payload: { content: 'hi', platformData: { messageId: 5, fromId: 42 } },
    from: 'telegram.tg-bot.bot',
    budget: {
      hopCount: 0,
      maxHops: 5,
      ttl: Date.now() + 60000,
      callBudgetRemaining: 10,
      ancestorChain: [],
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('BindingRouter → the bridge (chats-as-channels §5.1)', () => {
  let router: BindingRouter;
  let mockRelayCore: RelayCoreLike;
  let mockAgentManager: AgentSessionCreator;
  let mockMeshCore: AdapterMeshCoreLike;
  let mockBindingStore: Partial<BindingStore>;
  let mockRuntimeResolver: RuntimeTypeResolver;
  let bridgeIngest: ChatBridgeIngest & { ingest: ReturnType<typeof vi.fn> };
  let capturedHandler:
    | ((envelope: Record<string, unknown>) => Promise<void | { handled: false; reason: string }>)
    | undefined;
  const mockUnsubscribe = vi.fn();

  beforeEach(async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue();
    vi.mocked(rename).mockResolvedValue();
    capturedHandler = undefined;

    mockRelayCore = {
      publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
      subscribe: vi.fn((_pattern: string, handler: unknown) => {
        capturedHandler = handler as typeof capturedHandler;
        return mockUnsubscribe;
      }),
    };
    // The session creator — the spy A2.1/A5.2 assert is never touched.
    mockAgentManager = { createSession: vi.fn().mockResolvedValue({ id: 'session-abc' }) };
    mockMeshCore = { getProjectPath: vi.fn().mockReturnValue('/agents/a') };
    mockBindingStore = {
      resolve: vi.fn().mockReturnValue(bridgedBinding()),
      resolveIncludingDisabled: vi.fn(),
      getById: vi.fn(),
    };
    mockRuntimeResolver = { getSessionRuntimeType: vi.fn().mockResolvedValue('claude-code') };
    bridgeIngest = {
      ingest: vi.fn(async (): Promise<IngestResult> => ({
        status: 'ingested',
        entryId: 'e1',
        joined: false,
      })),
    };

    router = new BindingRouter({
      bindingStore: mockBindingStore as BindingStore,
      relayCore: mockRelayCore,
      agentManager: mockAgentManager,
      meshCore: mockMeshCore,
      relayDir: '/tmp/relay',
      runtimeResolver: mockRuntimeResolver,
      bridgeIngest,
    });
    await router.init();
  });

  afterEach(async () => {
    await router.shutdown();
    vi.restoreAllMocks();
  });

  it('A2.1/A5.2: a bridged binding reaches ingest and NEVER the session creator', async () => {
    await capturedHandler!(inboundEnvelope());

    // It went to the bridge, with the bound agent's project path threaded in.
    expect(bridgeIngest.ingest).toHaveBeenCalledTimes(1);
    expect(bridgeIngest.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bind-bridged', bridge: 'room' }),
      expect.objectContaining({ subject: 'relay.human.telegram.tg-bot.123' }),
      { agentPath: '/agents/a' }
    );
    // The spy the spec names: no session was ever created for a bridged binding.
    expect(mockAgentManager.createSession).not.toHaveBeenCalled();
    // And nothing was republished to a `relay.agent.*` subject — no turn dispatch.
    expect(mockRelayCore.publish).not.toHaveBeenCalled();
  });

  it('A7.3: a bridged inbound causes no read or write of the session map', async () => {
    await capturedHandler!(inboundEnvelope());
    // The session map never gained an entry for this binding.
    expect(router.getSessionsByBinding('bind-bridged')).toEqual([]);
    expect(router.getAllSessions()).toEqual([]);
  });

  it('a refused ingest surfaces the verdict and still creates no session', async () => {
    bridgeIngest.ingest.mockResolvedValueOnce({
      status: 'refused',
      reason: 'bridge_rate_limited',
      verdict: { handled: false, reason: 'per-chat ingest ceiling reached' },
    });

    const verdict = await capturedHandler!(inboundEnvelope());

    expect(verdict).toEqual({ handled: false, reason: 'per-chat ingest ceiling reached' });
    expect(mockAgentManager.createSession).not.toHaveBeenCalled();
  });

  it('A12.1: an UNbridged binding on the same router still dispatches to a session, byte-identically to before the bridge existed', async () => {
    // A12.1 is a suite-level promise — "with no bridge enabled anywhere, the
    // full existing relay suite passes unchanged" — and this is its discrete
    // pin: on the SAME router that can route a bridge, a `bridge: 'off'` binding
    // never reaches `ingest` and takes the classic session-dispatch path exactly
    // as it did before this feature. The whole pre-existing relay/binding-router
    // suite continuing green is the rest of the criterion; this test is what a
    // future edit that leaks bridge behaviour into the unbridged path trips.
    vi.mocked(mockBindingStore.resolve!).mockReturnValue({
      ...bridgedBinding(),
      id: 'bind-classic',
      bridge: 'off',
      roomId: null,
    });

    await capturedHandler!(inboundEnvelope());

    // The classic path: the bridge is never consulted, a session is created, and
    // the message is republished to a `relay.agent.*` subject — no new behaviour.
    expect(bridgeIngest.ingest).not.toHaveBeenCalled();
    expect(mockAgentManager.createSession).toHaveBeenCalledTimes(1);
    expect(mockRelayCore.publish).toHaveBeenCalledTimes(1);
  });
});
