import { vi, beforeEach, afterEach, type Mock } from 'vitest';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import {
  BindingRouter,
  type BindingRouterDeps,
  type RelayCoreLike,
  type AgentSessionCreator,
  type RuntimeTypeResolver,
} from '../../binding-router.js';
import type { BindingStore } from '../../binding-store.js';
import type { AdapterMeshCoreLike } from '../../adapter-manager.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';

/** Shared setup for the BindingRouter tests; each file mocks `node:fs/promises` itself. */

/** The bound agent's own directory — who it is. */
export const AGENT_PATH = '/agents/a';

/**
 * Where a turn for that agent RUNS, per the injected agent-cwd chain: a
 * different path from {@link AGENT_PATH}, so a router stamping the raw project
 * path fails every cwd assertion. The real chain runs in the integration test.
 */
export const AGENT_CWD = '/agents/a/worktree';

/**
 * The injected stand-in for the agent-cwd chain: the agent's managed checkout
 * for {@link AGENT_PATH}, and every other agent's own home.
 */
export const fakeResolveCwd = async ({
  agentPath,
}: {
  agentPath: string;
}): Promise<{ cwd: string; rung: 'agent-managed' | 'agent-home' }> =>
  agentPath === AGENT_PATH
    ? { cwd: AGENT_CWD, rung: 'agent-managed' }
    : { cwd: agentPath, rung: 'agent-home' };

/** The router's subscription callback, as the relay would call it. */
export type InboundHandler = (envelope: Record<string, unknown>) => Promise<unknown>;

/** One inbound chat envelope on `relay.human.telegram.tg-bot.123`, payload `'hi'`. */
export function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

/** {@link envelope} in the direct chat `chatId`. */
export function chatEnvelope(
  chatId: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return envelope({ subject: `relay.human.telegram.tg-bot.${chatId}`, ...overrides });
}

/** A binding of `tg-bot` to `agent-a`, with `enabled` and `bridge` unset as an old row has them. */
export function binding(overrides: Record<string, unknown> = {}): AdapterBinding {
  return {
    id: 'bind-1',
    adapterId: 'tg-bot',
    agentId: 'agent-a',
    sessionStrategy: 'per-chat',
    label: '',
    permissionMode: 'acceptEdits',
    canInitiate: false,
    canReply: true,
    canReceive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as AdapterBinding;
}

/** The router under test and every collaborator it was built with. */
export interface RouterHarness {
  router: BindingRouter;
  handler: InboundHandler;
  relayCore: { publish: Mock; subscribe: Mock } & RelayCoreLike;
  agentManager: { createSession: Mock } & AgentSessionCreator;
  meshCore: { getProjectPath: Mock } & AdapterMeshCoreLike;
  bindingStore: { resolve: Mock; resolveIncludingDisabled: Mock; getById: Mock };
  runtimeResolver: { getSessionRuntimeType: Mock } & RuntimeTypeResolver;
  bridgeIngest: { ingest: Mock };
  unsubscribe: Mock;
  /** The approver allowlist the router reads; tests assign it. */
  approvers: string[];
  /** Point the binding store at one binding for every lookup. */
  bind(b?: AdapterBinding): void;
  /** The payload of the router's last publish. */
  lastPayload(): Record<string, unknown>;
  /** Start another router on the same collaborators; shut down after the test. */
  startRouter(
    overrides?: Partial<BindingRouterDeps>
  ): Promise<{ router: BindingRouter; handler: InboundHandler }>;
}

/** Register hooks that build a fresh {@link RouterHarness} per test; read its fields inside tests. */
export function useRouterHarness(): RouterHarness {
  const h = {} as RouterHarness;
  const extraRouters: BindingRouter[] = [];

  const depsFor = (overrides: Partial<BindingRouterDeps>): BindingRouterDeps => ({
    resolveCwd: fakeResolveCwd,
    bindingStore: h.bindingStore as unknown as BindingStore,
    relayCore: h.relayCore,
    agentManager: h.agentManager,
    meshCore: h.meshCore,
    relayDir: '/tmp/relay',
    runtimeResolver: h.runtimeResolver,
    bridgeIngest: h.bridgeIngest,
    approverAllowlistFor: () => h.approvers,
    ...overrides,
  });

  beforeEach(async () => {
    registerTestHomes([AGENT_PATH], { managed: { [AGENT_CWD]: AGENT_PATH } });
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue();
    vi.mocked(rename).mockResolvedValue();

    h.approvers = [];
    h.unsubscribe = vi.fn();
    h.relayCore = {
      publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
      subscribe: vi.fn(() => h.unsubscribe),
    };
    h.agentManager = { createSession: vi.fn().mockResolvedValue({ id: 'session-abc' }) };
    h.bridgeIngest = {
      ingest: vi.fn().mockResolvedValue({ status: 'ingested', entryId: 'e1', joined: false }),
    };
    h.meshCore = { getProjectPath: vi.fn().mockReturnValue(AGENT_PATH) };
    h.bindingStore = { resolve: vi.fn(), resolveIncludingDisabled: vi.fn(), getById: vi.fn() };
    h.runtimeResolver = { getSessionRuntimeType: vi.fn().mockResolvedValue('claude-code') };
    h.bind = (b = binding()) => h.bindingStore.resolve.mockReturnValue(b);
    h.lastPayload = () => h.relayCore.publish.mock.calls.at(-1)![1] as Record<string, unknown>;
    h.startRouter = async (overrides = {}) => {
      const deps = depsFor(overrides);
      const router = new BindingRouter(deps);
      await router.init();
      extraRouters.push(router);
      const subscribe = vi.mocked(deps.relayCore.subscribe);
      return { router, handler: subscribe.mock.calls.at(-1)![1] as unknown as InboundHandler };
    };

    h.router = new BindingRouter(depsFor({}));
    await h.router.init();
    h.handler = h.relayCore.subscribe.mock.calls.at(-1)![1] as InboundHandler;
  });

  afterEach(async () => {
    await h.router.shutdown();
    for (const router of extraRouters.splice(0)) await router.shutdown();
    vi.restoreAllMocks();
    clearTestHomes();
  });

  return h;
}
