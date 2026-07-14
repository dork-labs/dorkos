import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdapterManager, AdapterError } from '../adapter-manager.js';
import type { AdapterRegistry, RelayAdapter } from '@dorkos/relay';
import type { AdapterManagerDeps, AdapterMeshCoreLike } from '../adapter-manager.js';

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
}));

// Mock chokidar
vi.mock('chokidar', () => {
  const mockWatcher = {
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    default: {
      watch: vi.fn().mockReturnValue(mockWatcher),
    },
  };
});

// Mock node:module (createRequire)
vi.mock('node:module', () => ({
  createRequire: () => ({
    resolve: (id: string) => {
      if (id === '@dorkos/relay') return '/mock-relay/dist/index.js';
      return id;
    },
  }),
}));

// Mock logger
vi.mock('../../../lib/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createTaggedLogger: vi.fn(() => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Mock TelegramAdapter, WebhookAdapter, and ClaudeCodeAdapter
vi.mock('@dorkos/relay', async () => {
  const actual = await vi.importActual<object>('@dorkos/relay');
  return {
    ...actual,
    TelegramAdapter: vi.fn().mockImplementation(function (id: string) {
      return {
        id,
        subjectPrefix: 'relay.human.telegram',
        displayName: `Telegram (${id})`,
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 0 }),
        getStatus: vi.fn().mockReturnValue({
          state: 'connected',
          messageCount: { inbound: 0, outbound: 0 },
          errorCount: 0,
        }),
        testConnection: vi.fn().mockResolvedValue({ ok: true }),
        setLogger: vi.fn(),
      };
    }),
    WebhookAdapter: vi.fn().mockImplementation(function (id: string) {
      return {
        id,
        subjectPrefix: 'relay.webhook.test',
        displayName: `Webhook (${id})`,
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 0 }),
        getStatus: vi.fn().mockReturnValue({
          state: 'connected',
          messageCount: { inbound: 0, outbound: 0 },
          errorCount: 0,
        }),
        handleInbound: vi.fn().mockResolvedValue({ ok: true }),
      };
    }),
    ClaudeCodeAdapter: vi.fn().mockImplementation(function (id: string) {
      return {
        id,
        subjectPrefix: 'relay.agent.',
        displayName: 'Claude Code',
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 0 }),
        getStatus: vi.fn().mockReturnValue({
          state: 'connected',
          messageCount: { inbound: 0, outbound: 0 },
          errorCount: 0,
        }),
      };
    }),
    loadAdapters: vi.fn().mockResolvedValue([]),
  };
});

import { readFile, writeFile, rename } from 'node:fs/promises';
import chokidar from 'chokidar';

const VALID_CONFIG = JSON.stringify({
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
        inbound: {
          subject: 'relay.webhook.github',
          secret: 'a-very-long-secret-16',
        },
        outbound: {
          url: 'https://example.com/hook',
          secret: 'another-long-secret-16',
        },
      },
    },
  ],
});

/** Create a mock AdapterRegistry with all methods stubbed. */
function createMockRegistry(): AdapterRegistry {
  const adapters = new Map<string, RelayAdapter>();
  return {
    setRelay: vi.fn(),
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
}

/**
 * In-memory credential store + provider so the manager can materialize/resolve
 * adapter secrets (DOR-280) without the process-wide singletons that only
 * `initCredentialProvider` sets up in production.
 */
const secretStore = new Map<string, string>();
const mockCredentialStore = {
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

const mockDeps: AdapterManagerDeps = {
  agentManager: {
    ensureSession: vi.fn(),
    sendMessage: vi.fn(),
  },
  traceStore: {
    insertSpan: vi.fn(),
    updateSpan: vi.fn(),
  },
  credentialStore: mockCredentialStore,
  credentialProvider: mockCredentialProvider,
};

/**
 * initialize() starts adapters in the background; tests that assert on
 * started adapters must also wait for that pass to settle.
 */
async function initAndStart(m: AdapterManager): Promise<void> {
  await m.initialize();
  await m.adaptersStarted();
}

/** A promise with its resolver exposed, for deterministically gating async steps. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('AdapterManager', () => {
  let manager: AdapterManager;
  let registry: ReturnType<typeof createMockRegistry>;
  const configPath = '/home/test/.dork/relay/adapters.json';

  beforeEach(() => {
    vi.clearAllMocks();
    secretStore.clear();
    registry = createMockRegistry();
    manager = new AdapterManager(registry, configPath, mockDeps);
  });

  describe('initialize()', () => {
    it('reads config and starts enabled adapters', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);

      await initAndStart(manager);

      expect(readFile).toHaveBeenCalledWith(configPath, 'utf-8');
      // Only tg-main is enabled, wh-github is disabled
      expect(registry.register).toHaveBeenCalledOnce();
      expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ id: 'tg-main' }));
    });

    it('skips disabled adapters', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);

      await initAndStart(manager);

      // wh-github is disabled, should not be registered
      const registerCalls = vi.mocked(registry.register).mock.calls;
      const registeredIds = registerCalls.map((call) => (call[0] as RelayAdapter).id);
      expect(registeredIds).not.toContain('wh-github');
    });

    it('starts the config file watcher', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);

      await initAndStart(manager);

      expect(chokidar.watch).toHaveBeenCalledWith(
        configPath,
        expect.objectContaining({
          persistent: true,
          ignoreInitial: true,
        })
      );
    });
  });

  describe('reload()', () => {
    it('detects config changes and reconciles', async () => {
      // Initial config: one enabled adapter
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      // New config: tg-main disabled, wh-github enabled
      const newConfig = JSON.stringify({
        adapters: [
          {
            id: 'tg-main',
            type: 'telegram',
            enabled: false,
            config: { token: 'bot-token-123', mode: 'polling' },
          },
          {
            id: 'wh-github',
            type: 'webhook',
            enabled: true,
            config: {
              inbound: { subject: 'relay.webhook.github', secret: 'a-very-long-secret-16' },
              outbound: { url: 'https://example.com/hook', secret: 'another-long-secret-16' },
            },
          },
        ],
      });
      vi.mocked(readFile).mockResolvedValue(newConfig);

      await manager.reload();

      // tg-main should be unregistered (now disabled)
      expect(registry.unregister).toHaveBeenCalledWith('tg-main');
      // wh-github should be registered (now enabled)
      expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ id: 'wh-github' }));
    });

    it('unregisters adapters removed from config', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      // New config has no adapters
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));

      await manager.reload();

      // tg-main should be unregistered (removed from config)
      expect(registry.unregister).toHaveBeenCalledWith('tg-main');
    });
  });

  describe('enable()', () => {
    it('updates config and starts adapter', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);
      vi.clearAllMocks();

      await manager.enable('wh-github');

      expect(writeFile).toHaveBeenCalledWith(
        `${configPath}.tmp`,
        expect.stringContaining('"enabled": true'),
        { encoding: 'utf-8', mode: 0o600 }
      );
      expect(rename).toHaveBeenCalledWith(`${configPath}.tmp`, configPath);
      expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ id: 'wh-github' }));
    });

    it('throws for unknown adapter ID', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      await expect(manager.enable('nonexistent')).rejects.toThrow('Adapter not found: nonexistent');
    });
  });

  describe('disable()', () => {
    it('updates config and stops adapter', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);
      vi.clearAllMocks();

      await manager.disable('tg-main');

      expect(writeFile).toHaveBeenCalledWith(
        `${configPath}.tmp`,
        expect.stringContaining('"enabled": false'),
        { encoding: 'utf-8', mode: 0o600 }
      );
      expect(rename).toHaveBeenCalledWith(`${configPath}.tmp`, configPath);
      expect(registry.unregister).toHaveBeenCalledWith('tg-main');
    });

    it('throws for unknown adapter ID', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      await expect(manager.disable('nonexistent')).rejects.toThrow(
        'Adapter not found: nonexistent'
      );
    });
  });

  describe('listAdapters()', () => {
    it('returns config + status for each adapter', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const adapters = manager.listAdapters();

      expect(adapters).toHaveLength(2);
      expect(adapters[0].config.id).toBe('tg-main');
      expect(adapters[0].status).toBeDefined();
      expect(adapters[1].config.id).toBe('wh-github');
    });

    it('returns disconnected status for non-running adapters', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const adapters = manager.listAdapters();

      // wh-github is disabled, not in the registry -> disconnected status
      const whGithub = adapters.find((a) => a.config.id === 'wh-github');
      expect(whGithub?.status.state).toBe('disconnected');
    });
  });

  describe('getAdapter()', () => {
    it('returns config and status for known adapter', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const result = manager.getAdapter('tg-main');

      expect(result).toBeDefined();
      expect(result!.config.id).toBe('tg-main');
      expect(result!.status).toBeDefined();
    });

    it('returns undefined for unknown ID', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      expect(manager.getAdapter('nonexistent')).toBeUndefined();
    });

    it('masks sensitive config fields', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const result = manager.getAdapter('tg-main');
      expect(result).toBeDefined();
      const config = result!.config.config as Record<string, unknown>;
      expect(config.token).toBe('***');
      expect(config.mode).toBe('polling');
    });

    it('returns same masked format as listAdapters()', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const single = manager.getAdapter('tg-main');
      const list = manager.listAdapters();
      const fromList = list.find((a) => a.config.id === 'tg-main');

      expect(single!.config.config).toEqual(fromList!.config.config);
    });

    it('masks nested sensitive fields', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const result = manager.getAdapter('wh-github');
      expect(result).toBeDefined();
      const config = result!.config.config as Record<string, Record<string, unknown>>;
      expect(config.inbound.secret).toBe('***');
      expect(config.outbound.secret).toBe('***');
      expect(config.inbound.subject).toBe('relay.webhook.github');
      expect(config.outbound.url).toBe('https://example.com/hook');
    });
  });

  describe('shutdown()', () => {
    it('stops all adapters and config watcher', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const mockWatcher = vi.mocked(chokidar.watch).mock.results[0].value;

      await manager.shutdown();

      expect(mockWatcher.close).toHaveBeenCalledOnce();
      expect(registry.shutdown).toHaveBeenCalledOnce();
    });

    it('works when no config watcher exists', async () => {
      // No initialize called -> no watcher
      await expect(manager.shutdown()).resolves.not.toThrow();
      expect(registry.shutdown).toHaveBeenCalledOnce();
    });
  });

  describe('getCatalog()', () => {
    it('returns all three built-in manifests after initialize', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const catalog = manager.getCatalog();

      const types = catalog.map((e) => e.manifest.type);
      expect(types).toContain('telegram');
      expect(types).toContain('webhook');
      expect(types).toContain('claude-code');
    });

    it('returns empty instances for adapter types with no configured instances', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const catalog = manager.getCatalog();
      const claudeCode = catalog.find((e) => e.manifest.type === 'claude-code');

      expect(claudeCode).toBeDefined();
      expect(claudeCode!.instances).toHaveLength(0);
    });

    it('returns correct enabled and status for configured instances', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const catalog = manager.getCatalog();
      const telegram = catalog.find((e) => e.manifest.type === 'telegram');

      expect(telegram).toBeDefined();
      expect(telegram!.instances).toHaveLength(1);
      expect(telegram!.instances[0].id).toBe('tg-main');
      expect(telegram!.instances[0].enabled).toBe(true);
      expect(telegram!.instances[0].status.state).toBe('connected');
    });

    it('returns label in instances when adapter has a label', async () => {
      const configWithLabel = JSON.stringify({
        adapters: [
          {
            id: 'tg-main',
            type: 'telegram',
            enabled: true,
            label: 'My Bot',
            config: { token: 'bot-token-123', mode: 'polling' },
          },
        ],
      });
      vi.mocked(readFile).mockResolvedValue(configWithLabel);
      await initAndStart(manager);

      const catalog = manager.getCatalog();
      const telegram = catalog.find((e) => e.manifest.type === 'telegram');

      expect(telegram!.instances[0].label).toBe('My Bot');
    });

    it('does not include label key when adapter has no label', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const catalog = manager.getCatalog();
      const telegram = catalog.find((e) => e.manifest.type === 'telegram');

      expect(telegram!.instances[0].label).toBeUndefined();
    });
  });

  describe('maskSensitiveFields (via listAdapters)', () => {
    it('replaces top-level password fields with ***', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const adapters = manager.listAdapters();
      const tg = adapters.find((a) => a.config.id === 'tg-main');
      const config = tg!.config.config as Record<string, unknown>;

      expect(config.token).toBe('***');
      expect(config.mode).toBe('polling');
    });

    it('replaces nested dot-notation password fields with ***', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const adapters = manager.listAdapters();
      const wh = adapters.find((a) => a.config.id === 'wh-github');
      const config = wh!.config.config as Record<string, Record<string, unknown>>;

      expect(config.inbound.secret).toBe('***');
      expect(config.outbound.secret).toBe('***');
      // Non-password fields preserved
      expect(config.inbound.subject).toBe('relay.webhook.github');
      expect(config.outbound.url).toBe('https://example.com/hook');
    });

    it('preserves non-password fields unchanged', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const adapters = manager.listAdapters();
      const tg = adapters.find((a) => a.config.id === 'tg-main');
      const config = tg!.config.config as Record<string, unknown>;

      expect(config.mode).toBe('polling');
    });

    it('handles missing nested paths gracefully', async () => {
      // Config with a flat structure but webhook manifest expects nested keys
      const configWithFlat = JSON.stringify({
        adapters: [
          {
            id: 'wh-flat',
            type: 'webhook',
            enabled: true,
            config: { someKey: 'value' },
          },
        ],
      });
      vi.mocked(readFile).mockResolvedValue(configWithFlat);
      await initAndStart(manager);

      // Should not throw even though inbound.secret path doesn't exist
      const adapters = manager.listAdapters();
      expect(adapters).toHaveLength(1);
      const config = adapters[0].config.config as Record<string, unknown>;
      expect(config.someKey).toBe('value');
    });
  });

  describe('getManifest()', () => {
    it('returns manifest for known type', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const manifest = manager.getManifest('telegram');
      expect(manifest).toBeDefined();
      expect(manifest!.displayName).toBe('Telegram');
    });

    it('returns undefined for unknown type', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      expect(manager.getManifest('unknown')).toBeUndefined();
    });
  });

  describe('registerPluginManifest()', () => {
    it('adds a custom manifest to the catalog', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
      await initAndStart(manager);

      manager.registerPluginManifest('custom-adapter', {
        type: 'custom-adapter',
        displayName: 'Custom',
        description: 'A custom adapter',
        category: 'custom',
        builtin: false,
        configFields: [],
        multiInstance: false,
      });

      const manifest = manager.getManifest('custom-adapter');
      expect(manifest).toBeDefined();
      expect(manifest!.displayName).toBe('Custom');

      // Also appears in catalog
      const catalog = manager.getCatalog();
      const custom = catalog.find((e) => e.manifest.type === 'custom-adapter');
      expect(custom).toBeDefined();
      expect(custom!.instances).toHaveLength(0);
    });
  });

  describe('testConnection()', () => {
    it('prefers adapter.testConnection() when available', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const result = await manager.testConnection('telegram', {
        token: 'test-token',
        mode: 'polling',
      });

      expect(result).toEqual({ ok: true });
    });

    it('does NOT call start() when adapter has testConnection()', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const testFn = vi.fn().mockResolvedValue({ ok: true });
      const startFn = vi.fn().mockResolvedValue(undefined);
      const { TelegramAdapter: TgMock } = await import('@dorkos/relay');
      vi.mocked(TgMock).mockImplementationOnce(function (id: string) {
        return {
          id,
          subjectPrefix: 'relay.human.telegram',
          displayName: `Telegram (${id})`,
          start: startFn,
          stop: vi.fn().mockResolvedValue(undefined),
          deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 0 }),
          getStatus: vi.fn().mockReturnValue({
            state: 'disconnected',
            messageCount: { inbound: 0, outbound: 0 },
            errorCount: 0,
          }),
          testConnection: testFn,
          setLogger: vi.fn(),
        };
      });

      await manager.testConnection('telegram', { token: 't', mode: 'polling' });

      expect(testFn).toHaveBeenCalledOnce();
      expect(startFn).not.toHaveBeenCalled();
    });

    it('returns { ok: false } when adapter.testConnection() returns error', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const { TelegramAdapter: TgMock } = await import('@dorkos/relay');
      vi.mocked(TgMock).mockImplementationOnce(function (id: string) {
        return {
          id,
          subjectPrefix: 'relay.human.telegram',
          displayName: `Telegram (${id})`,
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 0 }),
          getStatus: vi.fn().mockReturnValue({
            state: 'disconnected',
            messageCount: { inbound: 0, outbound: 0 },
            errorCount: 0,
          }),
          testConnection: vi.fn().mockResolvedValue({ ok: false, error: 'Unauthorized' }),
          setLogger: vi.fn(),
        };
      });

      const result = await manager.testConnection('telegram', {
        token: 'bad-token',
        mode: 'polling',
      });

      expect(result).toEqual({ ok: false, error: 'Unauthorized' });
    });

    it('falls back to start/stop when adapter has no testConnection()', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const startFn = vi.fn().mockResolvedValue(undefined);
      const stopFn = vi.fn().mockResolvedValue(undefined);
      const { TelegramAdapter: TgMock } = await import('@dorkos/relay');
      vi.mocked(TgMock).mockImplementationOnce(function (id: string) {
        return {
          id,
          subjectPrefix: 'relay.human.telegram',
          displayName: `Telegram (${id})`,
          start: startFn,
          stop: stopFn,
          deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 0 }),
          getStatus: vi.fn().mockReturnValue({
            state: 'connected',
            messageCount: { inbound: 0, outbound: 0 },
            errorCount: 0,
          }),
          setLogger: vi.fn(),
          // No testConnection — forces fallback to start/stop
        };
      });

      const result = await manager.testConnection('telegram', { token: 't', mode: 'polling' });

      expect(result).toEqual({ ok: true });
      expect(startFn).toHaveBeenCalledOnce();
      expect(stopFn).toHaveBeenCalledOnce();
    });

    it('returns { ok: false } for unknown adapter type', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const result = await manager.testConnection('nonexistent', {});

      expect(result).toEqual({ ok: false, error: 'Unknown adapter type: nonexistent' });
    });

    it('always calls stop() on the adapter in fallback path, even on failure', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const stopFn = vi.fn().mockResolvedValue(undefined);
      const { TelegramAdapter: TgMock } = await import('@dorkos/relay');
      vi.mocked(TgMock).mockImplementationOnce(function (id: string) {
        return {
          id,
          subjectPrefix: 'relay.human.telegram',
          displayName: `Telegram (${id})`,
          start: vi.fn().mockRejectedValue(new Error('fail')),
          stop: stopFn,
          deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 0 }),
          getStatus: vi.fn().mockReturnValue({
            state: 'disconnected',
            messageCount: { inbound: 0, outbound: 0 },
            errorCount: 0,
          }),
          setLogger: vi.fn(),
          // No testConnection — forces fallback
        };
      });

      await manager.testConnection('telegram', { token: 't', mode: 'polling' });

      expect(stopFn).toHaveBeenCalledOnce();
    });

    it('does NOT register the adapter in the registry', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);
      vi.clearAllMocks();

      await manager.testConnection('telegram', { token: 't', mode: 'polling' });

      expect(registry.register).not.toHaveBeenCalled();
    });

    it('times out after 15 seconds if testConnection() hangs', async () => {
      vi.useFakeTimers();
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const stopFn = vi.fn().mockResolvedValue(undefined);
      const { TelegramAdapter: TgMock } = await import('@dorkos/relay');
      vi.mocked(TgMock).mockImplementationOnce(function (id: string) {
        return {
          id,
          subjectPrefix: 'relay.human.telegram',
          displayName: `Telegram (${id})`,
          start: vi.fn().mockReturnValue(new Promise(() => {})),
          stop: stopFn,
          deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 0 }),
          getStatus: vi.fn().mockReturnValue({
            state: 'disconnected',
            messageCount: { inbound: 0, outbound: 0 },
            errorCount: 0,
          }),
          testConnection: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
          setLogger: vi.fn(),
        };
      });

      const resultPromise = manager.testConnection('telegram', {
        token: 't',
        mode: 'polling',
      });

      await vi.advanceTimersByTimeAsync(15_000);

      const result = await resultPromise;

      expect(result).toEqual({ ok: false, error: 'Connection test timed out' });
      expect(stopFn).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });

    it('clears timeout timer on successful testConnection()', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      await manager.testConnection('telegram', {
        token: 'test-token',
        mode: 'polling',
      });

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    it('clears timeout timer on successful fallback start/stop', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const { TelegramAdapter: TgMock } = await import('@dorkos/relay');
      vi.mocked(TgMock).mockImplementationOnce(function (id: string) {
        return {
          id,
          subjectPrefix: 'relay.human.telegram',
          displayName: `Telegram (${id})`,
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 0 }),
          getStatus: vi.fn().mockReturnValue({
            state: 'connected',
            messageCount: { inbound: 0, outbound: 0 },
            errorCount: 0,
          }),
          setLogger: vi.fn(),
          // No testConnection — forces fallback
        };
      });

      await manager.testConnection('telegram', { token: 't', mode: 'polling' });

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });

  describe('addAdapter()', () => {
    it('adds a new adapter to configs and persists', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
      await initAndStart(manager);
      vi.clearAllMocks();

      await manager.addAdapter('webhook', 'wh-new', {
        inbound: { subject: 'relay.webhook.test', secret: 'secret-16-chars!!' },
        outbound: { url: 'https://example.com', secret: 'secret-16-chars!!' },
      });

      expect(writeFile).toHaveBeenCalledWith(
        `${configPath}.tmp`,
        expect.stringContaining('"wh-new"'),
        { encoding: 'utf-8', mode: 0o600 }
      );
      expect(rename).toHaveBeenCalledWith(`${configPath}.tmp`, configPath);
      const adapters = manager.listAdapters();
      expect(adapters).toHaveLength(1);
      expect(adapters[0].config.id).toBe('wh-new');
    });

    it('starts the adapter if enabled', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
      await initAndStart(manager);
      vi.clearAllMocks();

      await manager.addAdapter('webhook', 'wh-new', {
        inbound: { subject: 'relay.webhook.test', secret: 'secret-16-chars!!' },
        outbound: { url: 'https://example.com', secret: 'secret-16-chars!!' },
      });

      expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ id: 'wh-new' }));
    });

    it('does not start the adapter if disabled', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
      await initAndStart(manager);
      vi.clearAllMocks();

      await manager.addAdapter(
        'webhook',
        'wh-new',
        {
          inbound: { subject: 'relay.webhook.test', secret: 'secret-16-chars!!' },
          outbound: { url: 'https://example.com', secret: 'secret-16-chars!!' },
        },
        false
      );

      expect(registry.register).not.toHaveBeenCalled();
    });

    it('rejects duplicate IDs with DUPLICATE_ID', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      await expect(manager.addAdapter('webhook', 'tg-main', {})).rejects.toThrow(AdapterError);

      try {
        await manager.addAdapter('webhook', 'tg-main', {});
      } catch (err) {
        expect((err as AdapterError).code).toBe('DUPLICATE_ID');
      }
    });

    it('rejects unknown adapter types with UNKNOWN_TYPE', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
      await initAndStart(manager);

      await expect(manager.addAdapter('nonexistent-type', 'new-id', {})).rejects.toThrow(
        AdapterError
      );

      try {
        await manager.addAdapter('nonexistent-type', 'new-id', {});
      } catch (err) {
        expect((err as AdapterError).code).toBe('UNKNOWN_TYPE');
      }
    });

    it('rejects second instance of non-multiInstance type', async () => {
      const configWithClaudeCode = JSON.stringify({
        adapters: [
          ...JSON.parse(VALID_CONFIG).adapters,
          { id: 'cc-main', type: 'claude-code', enabled: false, config: {} },
        ],
      });
      vi.mocked(readFile).mockResolvedValue(configWithClaudeCode);
      await initAndStart(manager);

      // claude-code is non-multiInstance, cc-main already exists
      await expect(manager.addAdapter('claude-code', 'cc-second', {})).rejects.toThrow(
        AdapterError
      );

      try {
        await manager.addAdapter('claude-code', 'cc-second', {});
      } catch (err) {
        expect((err as AdapterError).code).toBe('MULTI_INSTANCE_DENIED');
      }
    });

    it('allows second instance of multiInstance type (webhook)', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      // webhook is multiInstance, wh-github already exists
      await expect(
        manager.addAdapter('webhook', 'wh-second', {
          inbound: { subject: 'relay.webhook.test2', secret: 'secret-16-chars!!' },
          outbound: { url: 'https://example2.com', secret: 'secret-16-chars!!' },
        })
      ).resolves.not.toThrow();

      const adapters = manager.listAdapters();
      const whIds = adapters.filter((a) => a.config.type === 'webhook').map((a) => a.config.id);
      expect(whIds).toContain('wh-github');
      expect(whIds).toContain('wh-second');
    });

    it('allows second instance of multiInstance type (telegram)', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      // telegram is multiInstance, tg-main already exists
      await expect(
        manager.addAdapter('telegram', 'tg-second', { token: 'tok2', mode: 'polling' })
      ).resolves.not.toThrow();

      const adapters = manager.listAdapters();
      const tgIds = adapters.filter((a) => a.config.type === 'telegram').map((a) => a.config.id);
      expect(tgIds).toContain('tg-main');
      expect(tgIds).toContain('tg-second');
    });

    it('getCatalog() shows both Telegram instances under the telegram entry', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      await manager.addAdapter('telegram', 'tg-second', { token: 'tok2', mode: 'polling' });

      const catalog = manager.getCatalog();
      const telegram = catalog.find((e) => e.manifest.type === 'telegram');

      expect(telegram).toBeDefined();
      expect(telegram!.instances).toHaveLength(2);

      const instanceIds = telegram!.instances.map((i) => i.id);
      expect(instanceIds).toContain('tg-main');
      expect(instanceIds).toContain('tg-second');
    });

    it('independent enable/disable works for each Telegram instance', async () => {
      const twoTelegramConfig = JSON.stringify({
        adapters: [
          {
            id: 'tg-first',
            type: 'telegram',
            enabled: true,
            config: { token: 'tok1', mode: 'polling' },
          },
          {
            id: 'tg-second',
            type: 'telegram',
            enabled: true,
            config: { token: 'tok2', mode: 'polling' },
          },
        ],
      });
      vi.mocked(readFile).mockResolvedValue(twoTelegramConfig);
      await initAndStart(manager);
      vi.clearAllMocks();

      // Disable only tg-first, tg-second should remain enabled
      await manager.disable('tg-first');

      expect(registry.unregister).toHaveBeenCalledWith('tg-first');
      expect(registry.unregister).not.toHaveBeenCalledWith('tg-second');

      const adapters = manager.listAdapters();
      const first = adapters.find((a) => a.config.id === 'tg-first');
      const second = adapters.find((a) => a.config.id === 'tg-second');
      expect(first!.config.enabled).toBe(false);
      expect(second!.config.enabled).toBe(true);
    });

    it('stores label at top-level when provided', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
      await initAndStart(manager);
      vi.clearAllMocks();

      await manager.addAdapter(
        'telegram',
        'tg-labeled',
        { token: 'tok', mode: 'polling' },
        true,
        '@MyBot'
      );

      // Label is stored in persisted config
      const savedJson = vi.mocked(writeFile).mock.calls.at(-1)?.[1] as string;
      const savedAdapters = JSON.parse(savedJson).adapters;
      const saved = savedAdapters.find((a: { id: string }) => a.id === 'tg-labeled');
      expect(saved.label).toBe('@MyBot');
      // Adapter-specific config does NOT contain label
      expect(saved.config.label).toBeUndefined();
    });

    it('does not include label in persisted config when omitted', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
      await initAndStart(manager);
      vi.clearAllMocks();

      await manager.addAdapter('telegram', 'tg-nolabel', { token: 'tok', mode: 'polling' });

      const savedJson = vi.mocked(writeFile).mock.calls.at(-1)?.[1] as string;
      const savedAdapters = JSON.parse(savedJson).adapters;
      const saved = savedAdapters.find((a: { id: string }) => a.id === 'tg-nolabel');
      expect(saved.label).toBeUndefined();
    });

    it('records adapter.connected event on successful start', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
      const mockEventRecorder = { insertAdapterEvent: vi.fn() };
      const depsWithRecorder = { ...mockDeps, eventRecorder: mockEventRecorder };
      const managerWithRecorder = new AdapterManager(registry, configPath, depsWithRecorder);
      await managerWithRecorder.initialize();

      await managerWithRecorder.addAdapter('webhook', 'wh-test', {
        inbound: { subject: 'relay.webhook.test', secret: 'secret-16-chars!!' },
        outbound: { url: 'https://example.com', secret: 'secret-16-chars!!' },
      });

      expect(mockEventRecorder.insertAdapterEvent).toHaveBeenCalledWith(
        'wh-test',
        'adapter.connected',
        'Connected to relay'
      );
    });

    it('records adapter.error event and re-throws when register() fails', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
      const mockEventRecorder = { insertAdapterEvent: vi.fn() };
      const depsWithRecorder = { ...mockDeps, eventRecorder: mockEventRecorder };
      const failRegistry = createMockRegistry();
      vi.mocked(failRegistry.register).mockRejectedValue(new Error('start failed'));
      const managerWithRecorder = new AdapterManager(failRegistry, configPath, depsWithRecorder);
      await managerWithRecorder.initialize();

      await expect(
        managerWithRecorder.addAdapter('webhook', 'wh-fail', {
          inbound: { subject: 'relay.webhook.test', secret: 'secret-16-chars!!' },
          outbound: { url: 'https://example.com', secret: 'secret-16-chars!!' },
        })
      ).rejects.toThrow('start failed');

      expect(mockEventRecorder.insertAdapterEvent).toHaveBeenCalledWith(
        'wh-fail',
        'adapter.error',
        'start failed'
      );
    });

    it('label is NOT passed to the adapter constructor', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
      await initAndStart(manager);
      vi.clearAllMocks();

      const { TelegramAdapter: TgMock } = await import('@dorkos/relay');
      const capturedConfig: Record<string, unknown>[] = [];
      vi.mocked(TgMock).mockImplementationOnce(function (id: string, cfg: Record<string, unknown>) {
        capturedConfig.push(cfg);
        return {
          id,
          subjectPrefix: 'relay.human.telegram',
          displayName: `Telegram (${id})`,
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 0 }),
          getStatus: vi.fn().mockReturnValue({
            state: 'connected',
            messageCount: { inbound: 0, outbound: 0 },
            errorCount: 0,
          }),
          testConnection: vi.fn().mockResolvedValue({ ok: true }),
          setLogger: vi.fn(),
        };
      });

      await manager.addAdapter(
        'telegram',
        'tg-test',
        { token: 'tok', mode: 'polling' },
        true,
        '@ShouldNotPassThrough'
      );

      // The label should not appear in the config passed to the adapter constructor
      // The config passed to the adapter is the adapter-specific config record
      expect(capturedConfig[0]).not.toHaveProperty('label');
    });
  });

  describe('updateAdapterLabel()', () => {
    it('sets label on an existing adapter and persists', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);
      vi.clearAllMocks();

      await manager.updateAdapterLabel('tg-main', 'Production Bot');

      const savedJson = vi.mocked(writeFile).mock.calls.at(-1)?.[1] as string;
      const savedAdapters = JSON.parse(savedJson).adapters;
      const saved = savedAdapters.find((a: { id: string }) => a.id === 'tg-main');
      expect(saved.label).toBe('Production Bot');
    });

    it('clears label when empty string provided', async () => {
      const configWithLabel = JSON.stringify({
        adapters: [
          {
            id: 'tg-main',
            type: 'telegram',
            enabled: true,
            label: 'Old Label',
            config: { token: 'bot-token-123', mode: 'polling' },
          },
        ],
      });
      vi.mocked(readFile).mockResolvedValue(configWithLabel);
      await initAndStart(manager);
      vi.clearAllMocks();

      await manager.updateAdapterLabel('tg-main', '');

      const savedJson = vi.mocked(writeFile).mock.calls.at(-1)?.[1] as string;
      const savedAdapters = JSON.parse(savedJson).adapters;
      const saved = savedAdapters.find((a: { id: string }) => a.id === 'tg-main');
      expect(saved.label).toBeUndefined();
    });

    it('label is reflected in getCatalog() after update', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      await manager.updateAdapterLabel('tg-main', 'Updated Label');

      const catalog = manager.getCatalog();
      const telegram = catalog.find((e) => e.manifest.type === 'telegram');
      expect(telegram!.instances[0].label).toBe('Updated Label');
    });

    it('throws NOT_FOUND for unknown adapter ID', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      try {
        await manager.updateAdapterLabel('nonexistent', 'Some Label');
      } catch (err) {
        expect(err).toBeInstanceOf(AdapterError);
        expect((err as AdapterError).code).toBe('NOT_FOUND');
      }
    });
  });

  describe('removeAdapter()', () => {
    it('stops, removes from config, persists', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);
      vi.clearAllMocks();

      await manager.removeAdapter('tg-main');

      expect(registry.unregister).toHaveBeenCalledWith('tg-main');
      expect(writeFile).toHaveBeenCalled();
      const adapters = manager.listAdapters();
      expect(adapters.find((a) => a.config.id === 'tg-main')).toBeUndefined();
    });

    it('returns NOT_FOUND for unknown IDs', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      try {
        await manager.removeAdapter('nonexistent');
      } catch (err) {
        expect(err).toBeInstanceOf(AdapterError);
        expect((err as AdapterError).code).toBe('NOT_FOUND');
      }
    });

    it('rejects removing built-in claude-code', async () => {
      const configWithClaude = JSON.stringify({
        adapters: [
          {
            id: 'claude-code',
            type: 'claude-code',
            builtin: true,
            enabled: true,
            config: { maxConcurrent: 3 },
          },
        ],
      });
      vi.mocked(readFile).mockResolvedValue(configWithClaude);
      await initAndStart(manager);

      try {
        await manager.removeAdapter('claude-code');
      } catch (err) {
        expect(err).toBeInstanceOf(AdapterError);
        expect((err as AdapterError).code).toBe('REMOVE_BUILTIN_DENIED');
      }
    });

    it('auto-deletes orphan bindings for the removed adapter', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      // Inject a mock bindingSubsystem whose getBindingStore() returns a mock store
      const mockBindingStore = {
        getAll: vi.fn().mockReturnValue([
          { id: 'b1', adapterId: 'tg-main', agentId: 'agent-1' },
          { id: 'b2', adapterId: 'tg-main', agentId: 'agent-2' },
          { id: 'b3', adapterId: 'wh-github', agentId: 'agent-3' },
        ]),
        delete: vi.fn().mockResolvedValue(true),
      };
      (manager as any).bindingSubsystem = { getBindingStore: () => mockBindingStore };

      await manager.removeAdapter('tg-main');

      // Should delete bindings for tg-main only
      expect(mockBindingStore.delete).toHaveBeenCalledTimes(2);
      expect(mockBindingStore.delete).toHaveBeenCalledWith('b1');
      expect(mockBindingStore.delete).toHaveBeenCalledWith('b2');
      // Should NOT delete the binding for wh-github
      expect(mockBindingStore.delete).not.toHaveBeenCalledWith('b3');
    });

    it('does not affect bindings for other adapters on removal', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      const mockBindingStore = {
        getAll: vi.fn().mockReturnValue([{ id: 'b1', adapterId: 'wh-github', agentId: 'agent-1' }]),
        delete: vi.fn().mockResolvedValue(true),
      };
      (manager as any).bindingSubsystem = { getBindingStore: () => mockBindingStore };

      await manager.removeAdapter('tg-main');

      // No bindings belong to tg-main, so nothing should be deleted
      expect(mockBindingStore.delete).not.toHaveBeenCalled();
    });
  });

  describe('updateConfig()', () => {
    it('merges new config and persists', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);
      vi.clearAllMocks();

      await manager.updateConfig('tg-main', { token: 'new-token', mode: 'webhook' });

      expect(writeFile).toHaveBeenCalled();
    });

    it('preserves password fields when empty string submitted', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      // Update with empty token (password field) — should preserve original
      await manager.updateConfig('tg-main', { token: '', mode: 'webhook' });

      // getAdapter() masks sensitive fields, so verify via persisted config
      const adapter = manager.getAdapter('tg-main');
      const config = adapter!.config.config as Record<string, unknown>;
      // Token is masked in output (sensitive field)
      expect(config.token).toBe('***');
      expect(config.mode).toBe('webhook');

      // The original secret is preserved — but at rest it is a credential
      // reference (DOR-280), and the encrypted store still resolves to the
      // original token, so the bound bot keeps working.
      const savedJson = vi.mocked(writeFile).mock.calls.at(-1)?.[1] as string;
      const savedAdapters = JSON.parse(savedJson).adapters;
      const savedTg = savedAdapters.find((a: { id: string }) => a.id === 'tg-main');
      expect(savedTg.config.token).toBe('file:relay-adapter-tg-main-token');
      expect(secretStore.get('relay-adapter-tg-main-token')).toBe('bot-token-123');
    });

    it('preserves password fields when *** submitted', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      await manager.updateConfig('tg-main', { token: '***', mode: 'webhook' });

      // getAdapter() masks sensitive fields
      const adapter = manager.getAdapter('tg-main');
      const config = adapter!.config.config as Record<string, unknown>;
      expect(config.token).toBe('***');

      // Preserved, and stored as a reference that still resolves (DOR-280).
      const savedJson = vi.mocked(writeFile).mock.calls.at(-1)?.[1] as string;
      const savedAdapters = JSON.parse(savedJson).adapters;
      const savedTg = savedAdapters.find((a: { id: string }) => a.id === 'tg-main');
      expect(savedTg.config.token).toBe('file:relay-adapter-tg-main-token');
      expect(secretStore.get('relay-adapter-tg-main-token')).toBe('bot-token-123');
    });

    it('preserves nested password fields (e.g., inbound.secret)', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      // Update wh-github with empty nested secrets — should preserve originals
      await manager.updateConfig('wh-github', {
        inbound: { subject: 'relay.webhook.new', secret: '' },
        outbound: { url: 'https://new.com', secret: '***' },
      });

      // getAdapter() masks sensitive fields
      const adapter = manager.getAdapter('wh-github');
      const config = adapter!.config.config as Record<string, Record<string, unknown>>;
      expect(config.inbound.secret).toBe('***');
      expect(config.outbound.secret).toBe('***');
      expect(config.inbound.subject).toBe('relay.webhook.new');
      expect(config.outbound.url).toBe('https://new.com');

      // Nested secrets are preserved too, each as a resolvable reference (DOR-280).
      const savedJson = vi.mocked(writeFile).mock.calls.at(-1)?.[1] as string;
      const savedAdapters = JSON.parse(savedJson).adapters;
      const savedWh = savedAdapters.find((a: { id: string }) => a.id === 'wh-github');
      expect(savedWh.config.inbound.secret).toBe('file:relay-adapter-wh-github-inbound-secret');
      expect(savedWh.config.outbound.secret).toBe('file:relay-adapter-wh-github-outbound-secret');
      expect(secretStore.get('relay-adapter-wh-github-inbound-secret')).toBe(
        'a-very-long-secret-16'
      );
      expect(secretStore.get('relay-adapter-wh-github-outbound-secret')).toBe(
        'another-long-secret-16'
      );
    });

    it('restarts adapter after config change', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);
      vi.clearAllMocks();

      // tg-main is enabled and running
      await manager.updateConfig('tg-main', { token: 'new-token', mode: 'polling' });

      // Should unregister and re-register
      expect(registry.unregister).toHaveBeenCalledWith('tg-main');
      expect(registry.register).toHaveBeenCalledWith(expect.objectContaining({ id: 'tg-main' }));
    });

    it('does not restart disabled adapter after config change', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);
      vi.clearAllMocks();

      // wh-github is disabled, should not restart
      await manager.updateConfig('wh-github', {
        inbound: { subject: 'relay.webhook.new', secret: 'new-secret-16-ch!' },
        outbound: { url: 'https://new.com', secret: 'new-secret-16-ch!' },
      });

      expect(registry.unregister).not.toHaveBeenCalled();
      expect(registry.register).not.toHaveBeenCalled();
    });

    it('returns NOT_FOUND for unknown IDs', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await initAndStart(manager);

      try {
        await manager.updateConfig('nonexistent', { key: 'value' });
      } catch (err) {
        expect(err).toBeInstanceOf(AdapterError);
        expect((err as AdapterError).code).toBe('NOT_FOUND');
      }
    });
  });

  describe('saveConfig atomicity (via addAdapter)', () => {
    it('writes to a tmp file first, then renames to the final path', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
      await initAndStart(manager);
      vi.clearAllMocks();

      await manager.addAdapter('webhook', 'wh-atomic', {
        inbound: { subject: 'relay.webhook.test', secret: 'secret-16-chars!!' },
        outbound: { url: 'https://example.com', secret: 'secret-16-chars!!' },
      });

      // writeFile should write to tmp path, owner-only (holds bot tokens)
      expect(writeFile).toHaveBeenCalledWith(`${configPath}.tmp`, expect.any(String), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      // rename should move tmp to final path
      expect(rename).toHaveBeenCalledWith(`${configPath}.tmp`, configPath);

      // rename should be called after writeFile
      const writeOrder = vi.mocked(writeFile).mock.invocationCallOrder[0];
      const renameOrder = vi.mocked(rename).mock.invocationCallOrder[0];
      expect(renameOrder).toBeGreaterThan(writeOrder);
    });
  });

  describe('buildContext()', () => {
    function createMockMeshCore(
      projectPaths: Record<string, string | undefined>
    ): AdapterMeshCoreLike {
      return {
        getProjectPath: vi.fn((agentId: string) => projectPaths[agentId]),
      };
    }

    function createMinimalDeps(overrides?: Partial<AdapterManagerDeps>): AdapterManagerDeps {
      return {
        agentManager: {
          ensureSession: vi.fn(),
          sendMessage: vi.fn(),
        } as unknown as AdapterManagerDeps['agentManager'],
        traceStore: {
          insertSpan: vi.fn(),
          updateSpan: vi.fn(),
        },
        ...overrides,
      };
    }

    it('returns valid AdapterContext with correct directory when meshCore resolves a path', () => {
      const meshCore = createMockMeshCore({
        '01JN4M2X5SZMHXP3EZFM9DWRXFK': '/home/user/projectB',
      });
      const deps = createMinimalDeps({ meshCore });
      const manager = new AdapterManager(registry, '/tmp/adapters.json', deps);

      const ctx = manager.buildContext('relay.agent.01JN4M2X5SZMHXP3EZFM9DWRXFK');

      expect(ctx).toEqual({
        agent: {
          directory: '/home/user/projectB',
          runtime: 'claude-code',
        },
      });
      expect(meshCore.getProjectPath).toHaveBeenCalledWith('01JN4M2X5SZMHXP3EZFM9DWRXFK');
    });

    it('returns undefined when agentId not found in Mesh', () => {
      const meshCore = createMockMeshCore({});
      const deps = createMinimalDeps({ meshCore });
      const manager = new AdapterManager(registry, '/tmp/adapters.json', deps);

      const ctx = manager.buildContext('relay.agent.UNKNOWN_AGENT_ULID');

      expect(ctx).toBeUndefined();
    });

    it('returns undefined when meshCore is not injected (backward compat)', () => {
      const deps = createMinimalDeps({ meshCore: undefined });
      const manager = new AdapterManager(registry, '/tmp/adapters.json', deps);

      const ctx = manager.buildContext('relay.agent.01JN4M2X');

      expect(ctx).toBeUndefined();
    });

    it('returns undefined for non-agent subjects (relay.human.*)', () => {
      const meshCore = createMockMeshCore({ 'some-id': '/path/to/project' });
      const deps = createMinimalDeps({ meshCore });
      const manager = new AdapterManager(registry, '/tmp/adapters.json', deps);

      expect(manager.buildContext('relay.human.console.client-1')).toBeUndefined();
      expect(manager.buildContext('relay.system.tasks.sched-1')).toBeUndefined();
      expect(manager.buildContext('relay.inbox.some-agent')).toBeUndefined();
    });

    it('derives the runtime type from a runtime-scoped subject', () => {
      const meshCore = createMockMeshCore({ 'sess-123': '/home/user/codex-proj' });
      const deps = createMinimalDeps({ meshCore });
      const manager = new AdapterManager(registry, '/tmp/adapters.json', deps);

      const ctx = manager.buildContext('relay.agent.codex.sess-123');

      expect(ctx).toEqual({
        agent: {
          directory: '/home/user/codex-proj',
          runtime: 'codex',
        },
      });
      expect(meshCore.getProjectPath).toHaveBeenCalledWith('sess-123');
    });

    it('correctly parses relay.agent.{agentId} segment at index 2', () => {
      const meshCore = createMockMeshCore({
        '01JN4M2X5SZMHXP3EZFM9DWRXFK': '/path/to/agent',
      });
      const deps = createMinimalDeps({ meshCore });
      const manager = new AdapterManager(registry, '/tmp/adapters.json', deps);

      const ctx = manager.buildContext('relay.agent.01JN4M2X5SZMHXP3EZFM9DWRXFK');
      expect(ctx?.agent.directory).toBe('/path/to/agent');
    });
  });

  describe('enrichManifestsWithDocs()', () => {
    // With the node:module mock, docs paths resolve to /mock-relay/dist/adapters/<type>/docs/setup.md

    it('enriches manifests with setupGuide when docs/setup.md exists', async () => {
      vi.mocked(readFile).mockImplementation(async (filePath: unknown) => {
        const p = String(filePath);
        if (p.endsWith('setup.md')) return '# Slack Setup\n\nFollow these steps.';
        return VALID_CONFIG;
      });

      await initAndStart(manager);

      const slackManifest = manager.getManifest('slack');
      expect(slackManifest?.setupGuide).toBe('# Slack Setup\n\nFollow these steps.');
    });

    it('leaves setupGuide undefined when docs/setup.md is missing', async () => {
      vi.mocked(readFile).mockImplementation(async (filePath: unknown) => {
        const p = String(filePath);
        if (p.endsWith('setup.md')) throw new Error('ENOENT');
        return VALID_CONFIG;
      });

      await initAndStart(manager);

      const claudeCodeManifest = manager.getManifest('claude-code');
      expect(claudeCodeManifest?.setupGuide).toBeUndefined();
    });

    it('does not overwrite existing inline setupGuide from plugin adapters', async () => {
      vi.mocked(readFile).mockImplementation(async (filePath: unknown) => {
        const p = String(filePath);
        if (p.endsWith('setup.md')) return 'Disk guide content';
        return JSON.stringify({ adapters: [] });
      });

      // Register a plugin manifest with inline setupGuide before initialization
      const freshManager = new AdapterManager(registry, configPath, mockDeps);
      freshManager.registerPluginManifest('custom', {
        type: 'custom',
        displayName: 'Custom',
        description: 'Custom adapter',
        category: 'custom',
        builtin: false,
        configFields: [],
        setupGuide: 'Inline guide content',
      });

      await freshManager.initialize();

      const manifest = freshManager.getManifest('custom');
      expect(manifest?.setupGuide).toBe('Inline guide content');
    });

    it('enriches catalog entries with setupGuide content', async () => {
      vi.mocked(readFile).mockImplementation(async (filePath: unknown) => {
        const p = String(filePath);
        if (p.includes('/slack/') && p.endsWith('setup.md')) return '# Slack Guide';
        if (p.endsWith('setup.md')) throw new Error('ENOENT');
        return VALID_CONFIG;
      });

      await initAndStart(manager);

      const catalog = manager.getCatalog();
      const slack = catalog.find((e) => e.manifest.type === 'slack');
      expect(slack?.manifest.setupGuide).toBe('# Slack Guide');
    });
  });

  describe('error handling', () => {
    it('missing config file -> empty adapter list, no crash', async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      vi.mocked(readFile).mockRejectedValue(err);

      await initAndStart(manager);

      expect(manager.listAdapters()).toHaveLength(0);
      expect(registry.register).not.toHaveBeenCalled();
    });

    it('malformed config -> log warning, empty adapter list', async () => {
      vi.mocked(readFile).mockResolvedValue('{ invalid json !!!');

      await initAndStart(manager);

      expect(manager.listAdapters()).toHaveLength(0);
    });

    it('invalid schema -> log warning, empty adapter list', async () => {
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          adapters: [{ id: '', type: 'unknown-type', enabled: true, config: {} }],
        })
      );

      await initAndStart(manager);

      expect(manager.listAdapters()).toHaveLength(0);
    });

    it('adapter start failure does not prevent other adapters', async () => {
      const configWithTwo = JSON.stringify({
        adapters: [
          {
            id: 'tg-main',
            type: 'telegram',
            enabled: true,
            config: { token: 'bot-token-123', mode: 'polling' },
          },
          {
            id: 'tg-secondary',
            type: 'telegram',
            enabled: true,
            config: { token: 'bot-token-456', mode: 'polling' },
          },
        ],
      });
      vi.mocked(readFile).mockResolvedValue(configWithTwo);

      // First register call fails, second succeeds
      let callCount = 0;
      vi.mocked(registry.register).mockImplementation(async (_adapter: RelayAdapter) => {
        callCount++;
        if (callCount === 1) throw new Error('Start failed');
      });

      await initAndStart(manager);

      // Both adapters should have been attempted
      expect(registry.register).toHaveBeenCalledTimes(2);
    });

    it('a dangling credential reference isolates to one adapter — the relay stays up (DOR-280)', async () => {
      // tg-ok has a resolvable token; tg-broken points at a file: reference
      // whose secret is absent (host.key rotated, secret deleted, etc).
      const configWithBrokenSecret = JSON.stringify({
        adapters: [
          {
            id: 'tg-broken',
            type: 'telegram',
            enabled: true,
            config: { token: 'file:relay-adapter-tg-broken-token', mode: 'polling' },
          },
          {
            id: 'tg-ok',
            type: 'telegram',
            enabled: true,
            config: { token: 'bot-token-ok', mode: 'polling' },
          },
        ],
      });
      vi.mocked(readFile).mockResolvedValue(configWithBrokenSecret);

      const mockEventRecorder = { insertAdapterEvent: vi.fn() };
      const brokenManager = new AdapterManager(registry, configPath, {
        ...mockDeps,
        eventRecorder: mockEventRecorder,
      });

      // initialize() must NOT throw — a single unresolvable secret cannot abort
      // the whole relay init.
      await expect(brokenManager.initialize()).resolves.toBeUndefined();
      await brokenManager.adaptersStarted();

      // Only the healthy adapter is registered; the broken one is skipped.
      expect(registry.register).toHaveBeenCalledTimes(1);
      const registered = vi.mocked(registry.register).mock.calls[0][0];
      expect(registered.id).toBe('tg-ok');

      // The broken adapter surfaces a descriptive, secret-free error event.
      const errorCall = mockEventRecorder.insertAdapterEvent.mock.calls.find(
        (c) => c[0] === 'tg-broken' && c[1] === 'adapter.error'
      );
      expect(errorCall).toBeDefined();
      expect(errorCall![2]).toContain('Failed to resolve credential');
      expect(errorCall![2]).toContain("'tg-broken'");
      expect(errorCall![2]).toContain("'token'");

      // The healthy adapter still connects.
      expect(mockEventRecorder.insertAdapterEvent).toHaveBeenCalledWith(
        'tg-ok',
        'adapter.connected',
        expect.any(String)
      );
    });
  });

  describe('registry serialization under concurrency', () => {
    const TWO_ENABLED_CONFIG = JSON.stringify({
      adapters: [
        {
          id: 'tg-first',
          type: 'telegram',
          enabled: true,
          config: { token: 'tok1', mode: 'polling' },
        },
        {
          id: 'tg-second',
          type: 'telegram',
          enabled: true,
          config: { token: 'tok2', mode: 'polling' },
        },
      ],
    });

    /**
     * Gate one adapter id's registry.register call behind an explicit
     * release, keeping the mock registry's normal bookkeeping. `reached`
     * resolves when register(id) has been CALLED (the pass is mid-register),
     * which is the deterministic hook the race tests pivot on — no sleeps.
     */
    function gateRegister(id: string): { reached: Promise<void>; release: () => void } {
      const original = vi.mocked(registry.register).getMockImplementation()!;
      const reached = deferred();
      const gate = deferred();
      vi.mocked(registry.register).mockImplementation(async (adapter: RelayAdapter) => {
        if (adapter.id === id) {
          reached.resolve();
          await gate.promise;
        }
        return original(adapter);
      });
      return { reached: reached.promise, release: gate.resolve };
    }

    /**
     * Let every pending microtask settle without resolving the register
     * gate. After this, a racing enable/disable has run as far as it can:
     * an unserialized implementation has fully completed its registry
     * mutation (the bug), while a serialized one is parked in the queue.
     */
    function flushMicrotasks(): Promise<void> {
      return new Promise((resolve) => setImmediate(resolve));
    }

    it('enable() while the start pass is mid-register of the same adapter registers it exactly once', async () => {
      vi.mocked(readFile).mockResolvedValue(TWO_ENABLED_CONFIG);
      const { reached, release } = gateRegister('tg-second');

      await manager.initialize();
      await reached; // pass is mid-register of tg-second: registry.get() still sees nothing

      const enablePromise = manager.enable('tg-second');
      await flushMicrotasks(); // an unserialized enable would double-register here
      release();
      await enablePromise;
      await manager.adaptersStarted();

      const secondRegisters = vi
        .mocked(registry.register)
        .mock.calls.filter((call) => (call[0] as RelayAdapter).id === 'tg-second');
      expect(secondRegisters).toHaveLength(1);
      expect(registry.get('tg-second')).toBeDefined();
    });

    it('disable() during the background start pass leaves the adapter unregistered', async () => {
      vi.mocked(readFile).mockResolvedValue(TWO_ENABLED_CONFIG);
      const { reached, release } = gateRegister('tg-second');

      await manager.initialize();
      await reached; // pass is mid-register of tg-second — the worst-case interleave

      const disablePromise = manager.disable('tg-second');
      // An unserialized disable would fully complete its (no-op) unregister
      // here, before the pass's in-flight register lands — the leak.
      await flushMicrotasks();
      release();
      await disablePromise;
      await manager.adaptersStarted();

      // The pass's in-flight register completed, but the queued unregister
      // landed after it — the adapter must not survive the disable.
      expect(registry.get('tg-second')).toBeUndefined();
      expect(manager.getAdapter('tg-second')!.config.enabled).toBe(false);
    });

    it('shutdown() mid-pass stops the pass from registering further adapters', async () => {
      vi.mocked(readFile).mockResolvedValue(TWO_ENABLED_CONFIG);
      const { reached, release } = gateRegister('tg-first');

      await manager.initialize();
      await reached; // pass is mid-register of tg-first

      await manager.shutdown();
      release();
      await manager.adaptersStarted();

      // Only tg-first (already in flight when shutdown ran) was registered;
      // the pass bailed before reaching tg-second.
      expect(registry.register).toHaveBeenCalledTimes(1);
      const registeredIds = vi
        .mocked(registry.register)
        .mock.calls.map((call) => (call[0] as RelayAdapter).id);
      expect(registeredIds).not.toContain('tg-second');
    });
  });
});
