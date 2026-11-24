import { vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import type { AdapterRegistry, RelayAdapter } from '@dorkos/relay';
import { AdapterManager } from '../../adapter-manager.js';
import type { AdapterManagerDeps } from '../../adapter-manager.js';
import { logger } from '../../../../lib/logger.js';

/**
 * Shared setup for the AdapterManager tests. Import this module FIRST in each
 * piece: the mocks below are registered when it is evaluated, which is before
 * the piece's later imports load `adapter-manager.js` and `@dorkos/relay`.
 * Keeping the one `@dorkos/relay` mock here keeps the own-module mock count at
 * one for the whole suite.
 */

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  // A failed atomic write removes its temp file.
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('chokidar', () => {
  const mockWatcher = { on: vi.fn().mockReturnThis(), close: vi.fn().mockResolvedValue(undefined) };
  return { default: { watch: vi.fn().mockReturnValue(mockWatcher) } };
});

// Docs paths resolve to /mock-relay/dist/adapters/<type>/docs/setup.md.
vi.mock('node:module', () => ({
  createRequire: () => ({
    resolve: (id: string) => (id === '@dorkos/relay' ? '/mock-relay/dist/index.js' : id),
  }),
}));

/**
 * The mocked `TelegramAdapter`'s `getMe`. Defaults to `null` ("not yet
 * connected"), same as the real accessor before `start()`.
 */
export const mockGetMe = vi.fn(
  async (): Promise<{ username: string; canReadAllGroupMessages: boolean } | null> => null
);

/** A connected-looking adapter double, for the mocked constructors and direct registration. */
export function fakeAdapter(
  id: string,
  subjectPrefix: string | string[],
  extra: Record<string, unknown> = {}
): RelayAdapter {
  return {
    id,
    subjectPrefix,
    displayName: id,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 0 }),
    getStatus: vi.fn().mockReturnValue({
      state: 'connected',
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
    }),
    ...extra,
  } as unknown as RelayAdapter;
}

vi.mock('@dorkos/relay', async () => {
  const actual = await vi.importActual<object>('@dorkos/relay');
  return {
    ...actual,
    TelegramAdapter: vi.fn().mockImplementation(function (id: string) {
      return fakeAdapter(id, 'relay.human.telegram', {
        testConnection: vi.fn().mockResolvedValue({ ok: true }),
        setLogger: vi.fn(),
        getMe: mockGetMe,
      });
    }),
    WebhookAdapter: vi.fn().mockImplementation(function (id: string) {
      return fakeAdapter(id, 'relay.webhook.test');
    }),
    // Both claims the real adapter makes; `canRunTaskOnBus` reads liveness off
    // the tasks one (DOR-1636).
    ClaudeCodeAdapter: vi.fn().mockImplementation(function (id: string) {
      return fakeAdapter(id, ['relay.agent.', 'relay.system.tasks.']);
    }),
    loadAdapters: vi.fn().mockResolvedValue([]),
  };
});

export const CONFIG_PATH = '/home/test/.dork/relay/adapters.json';

export const VALID_CONFIG = JSON.stringify({
  adapters: [
    {
      id: 'tg-main',
      type: 'telegram',
      enabled: true,
      config: { token: 'bot-token-123', mode: 'polling' },
    },
    {
      id: 'wh-github',
      type: 'webhook',
      enabled: false,
      config: {
        inbound: { subject: 'relay.webhook.github', secret: 'a-very-long-secret-16' },
        outbound: { url: 'https://example.com/hook', secret: 'another-long-secret-16' },
      },
    },
  ],
});

export const EMPTY_CONFIG = JSON.stringify({ adapters: [] });

export const NEW_HOOK = {
  inbound: { subject: 'relay.webhook.test', secret: 'secret-16-chars!!' },
  outbound: { url: 'https://example.com', secret: 'secret-16-chars!!' },
};

/** A mock AdapterRegistry that keeps real bookkeeping behind spies. */
export function createMockRegistry(): AdapterRegistry {
  const adapters = new Map<string, RelayAdapter>();
  const registry = {
    setRelay: vi.fn(),
    reserveOwnership: vi.fn(() => ({
      register: (adapter: RelayAdapter) => registry.register(adapter),
      release: vi.fn(),
    })),
    register: vi.fn(async (adapter: RelayAdapter) => {
      adapters.set(adapter.id, adapter);
    }),
    unregister: vi.fn(async (id: string) => {
      const had = adapters.has(id);
      adapters.delete(id);
      return had;
    }),
    get: vi.fn((id: string) => adapters.get(id)),
    getBySubject: vi.fn(),
    list: vi.fn(() => [...adapters.values()]),
    deliver: vi.fn().mockResolvedValue(false),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as AdapterRegistry;
  return registry;
}

/**
 * In-memory credential store + provider so the manager can materialize and
 * resolve adapter secrets (DOR-280) without the process-wide singletons.
 */
export const secretStore = new Map<string, string>();
export const mockCredentialStore = {
  put: vi.fn(async (name: string, secret: string) => {
    secretStore.set(name, secret);
    return `file:${name}`;
  }),
  get: vi.fn(async (name: string) => secretStore.get(name) ?? null),
  delete: vi.fn(async (name: string) => {
    secretStore.delete(name);
  }),
};
const mockCredentialProvider = {
  resolve: vi.fn(async (ref: string) => {
    const name = ref.slice(ref.indexOf(':') + 1);
    const secret = secretStore.get(name);
    return secret != null
      ? ({ ok: true, secret } as const)
      : ({ ok: false, reason: 'unresolved', ref, message: 'missing' } as const);
  }),
};

export const mockDeps: AdapterManagerDeps = {
  agentManager: {
    ensureSession: vi.fn(),
    sendMessage: vi.fn(),
    approveTool: vi.fn(),
    interruptQuery: vi.fn(),
  },
  traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() },
  credentialStore: mockCredentialStore,
  credentialProvider: mockCredentialProvider,
};

/** Reset every mock and hand back a fresh registry and manager. Call in `beforeEach`. */
export function freshHarness(): { manager: AdapterManager; registry: AdapterRegistry } {
  vi.clearAllMocks();
  secretStore.clear();
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation(() => undefined);
  }
  const registry = createMockRegistry();
  return { registry, manager: new AdapterManager(registry, CONFIG_PATH, mockDeps) };
}

/** Make the config file read back `contents`. */
export function withConfig(contents: string): void {
  vi.mocked(readFile).mockResolvedValue(contents);
}

/** initialize() starts adapters in the background; this also waits for that pass. */
export async function initAndStart(m: AdapterManager): Promise<void> {
  await m.initialize();
  await m.adaptersStarted();
}

/** The adapters array the last config save wrote. */
export function lastSaved(): Array<{
  id: string;
  enabled?: boolean;
  label?: string;
  config: {
    token?: string;
    dmPolicy?: string;
    label?: string;
    inbound?: { secret?: string };
    outbound?: { secret?: string };
  };
}> {
  return JSON.parse(String(vi.mocked(writeFile).mock.calls.at(-1)?.[1])).adapters;
}

/** A promise with its resolver exposed, for deterministically gating async steps. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let every pending microtask and I/O callback settle. */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
