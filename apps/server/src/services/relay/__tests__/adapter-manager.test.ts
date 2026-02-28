import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdapterManager, AdapterError } from '../adapter-manager.js';
import type { AdapterRegistry, RelayAdapter } from '@dorkos/relay';
import type { AdapterManagerDeps } from '../adapter-manager.js';

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
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

// Mock logger
vi.mock('../../../lib/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock TelegramAdapter, WebhookAdapter, and ClaudeCodeAdapter
vi.mock('@dorkos/relay', async () => {
  const actual = await vi.importActual<object>('@dorkos/relay');
  return {
    ...actual,
    TelegramAdapter: vi.fn().mockImplementation((id: string) => ({
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
    })),
    WebhookAdapter: vi.fn().mockImplementation((id: string) => ({
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
    })),
    ClaudeCodeAdapter: vi.fn().mockImplementation((id: string) => ({
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
    })),
    loadAdapters: vi.fn().mockResolvedValue([]),
  };
});

import { readFile, writeFile } from 'node:fs/promises';
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

const mockDeps: AdapterManagerDeps = {
  agentManager: {
    ensureSession: vi.fn(),
    sendMessage: vi.fn(),
  },
  traceStore: {
    insertSpan: vi.fn(),
    updateSpan: vi.fn(),
  },
};

describe('AdapterManager', () => {
  let manager: AdapterManager;
  let registry: ReturnType<typeof createMockRegistry>;
  const configPath = '/home/test/.dork/relay/adapters.json';

  beforeEach(() => {
    vi.clearAllMocks();
    registry = createMockRegistry();
    manager = new AdapterManager(registry, configPath, mockDeps);
  });

  describe('initialize()', () => {
    it('reads config and starts enabled adapters', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);

      await manager.initialize();

      expect(readFile).toHaveBeenCalledWith(configPath, 'utf-8');
      // Only tg-main is enabled, wh-github is disabled
      expect(registry.register).toHaveBeenCalledOnce();
      expect(registry.register).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tg-main' }),
      );
    });

    it('skips disabled adapters', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);

      await manager.initialize();

      // wh-github is disabled, should not be registered
      const registerCalls = vi.mocked(registry.register).mock.calls;
      const registeredIds = registerCalls.map((call) => (call[0] as RelayAdapter).id);
      expect(registeredIds).not.toContain('wh-github');
    });

    it('starts the config file watcher', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);

      await manager.initialize();

      expect(chokidar.watch).toHaveBeenCalledWith(configPath, expect.objectContaining({
        persistent: true,
        ignoreInitial: true,
      }));
    });
  });

  describe('reload()', () => {
    it('detects config changes and reconciles', async () => {
      // Initial config: one enabled adapter
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

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
      expect(registry.register).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'wh-github' }),
      );
    });

    it('unregisters adapters removed from config', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

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
      await manager.initialize();
      vi.clearAllMocks();

      await manager.enable('wh-github');

      expect(writeFile).toHaveBeenCalledWith(
        configPath,
        expect.stringContaining('"enabled": true'),
        'utf-8',
      );
      expect(registry.register).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'wh-github' }),
      );
    });

    it('throws for unknown adapter ID', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      await expect(manager.enable('nonexistent')).rejects.toThrow('Adapter not found: nonexistent');
    });
  });

  describe('disable()', () => {
    it('updates config and stops adapter', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();
      vi.clearAllMocks();

      await manager.disable('tg-main');

      expect(writeFile).toHaveBeenCalledWith(
        configPath,
        expect.stringContaining('"enabled": false'),
        'utf-8',
      );
      expect(registry.unregister).toHaveBeenCalledWith('tg-main');
    });

    it('throws for unknown adapter ID', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      await expect(manager.disable('nonexistent')).rejects.toThrow(
        'Adapter not found: nonexistent',
      );
    });
  });

  describe('listAdapters()', () => {
    it('returns config + status for each adapter', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      const adapters = manager.listAdapters();

      expect(adapters).toHaveLength(2);
      expect(adapters[0].config.id).toBe('tg-main');
      expect(adapters[0].status).toBeDefined();
      expect(adapters[1].config.id).toBe('wh-github');
    });

    it('returns disconnected status for non-running adapters', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      const adapters = manager.listAdapters();

      // wh-github is disabled, not in the registry -> disconnected status
      const whGithub = adapters.find((a) => a.config.id === 'wh-github');
      expect(whGithub?.status.state).toBe('disconnected');
    });
  });

  describe('getAdapter()', () => {
    it('returns config and status for known adapter', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      const result = manager.getAdapter('tg-main');

      expect(result).toBeDefined();
      expect(result!.config.id).toBe('tg-main');
      expect(result!.status).toBeDefined();
    });

    it('returns undefined for unknown ID', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      expect(manager.getAdapter('nonexistent')).toBeUndefined();
    });
  });

  describe('shutdown()', () => {
    it('stops all adapters and config watcher', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

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
      await manager.initialize();

      const catalog = manager.getCatalog();

      const types = catalog.map((e) => e.manifest.type);
      expect(types).toContain('telegram');
      expect(types).toContain('webhook');
      expect(types).toContain('claude-code');
    });

    it('returns empty instances for adapter types with no configured instances', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      const catalog = manager.getCatalog();
      const claudeCode = catalog.find((e) => e.manifest.type === 'claude-code');

      expect(claudeCode).toBeDefined();
      expect(claudeCode!.instances).toHaveLength(0);
    });

    it('returns correct enabled and status for configured instances', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      const catalog = manager.getCatalog();
      const telegram = catalog.find((e) => e.manifest.type === 'telegram');

      expect(telegram).toBeDefined();
      expect(telegram!.instances).toHaveLength(1);
      expect(telegram!.instances[0].id).toBe('tg-main');
      expect(telegram!.instances[0].enabled).toBe(true);
      expect(telegram!.instances[0].status.state).toBe('connected');
    });
  });

  describe('maskSensitiveFields (via listAdapters)', () => {
    it('replaces top-level password fields with ***', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      const adapters = manager.listAdapters();
      const tg = adapters.find((a) => a.config.id === 'tg-main');
      const config = tg!.config.config as Record<string, unknown>;

      expect(config.token).toBe('***');
      expect(config.mode).toBe('polling');
    });

    it('replaces nested dot-notation password fields with ***', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

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
      await manager.initialize();

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
      await manager.initialize();

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
      await manager.initialize();

      const manifest = manager.getManifest('telegram');
      expect(manifest).toBeDefined();
      expect(manifest!.displayName).toBe('Telegram');
    });

    it('returns undefined for unknown type', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      expect(manager.getManifest('unknown')).toBeUndefined();
    });
  });

  describe('registerPluginManifest()', () => {
    it('adds a custom manifest to the catalog', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
      await manager.initialize();

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
      await manager.initialize();

      const result = await manager.testConnection('telegram', {
        token: 'test-token',
        mode: 'polling',
      });

      expect(result).toEqual({ ok: true });
    });

    it('does NOT call start() when adapter has testConnection()', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      const testFn = vi.fn().mockResolvedValue({ ok: true });
      const startFn = vi.fn().mockResolvedValue(undefined);
      const { TelegramAdapter: TgMock } = await import('@dorkos/relay');
      vi.mocked(TgMock).mockImplementationOnce((id: string) => ({
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
      }));

      await manager.testConnection('telegram', { token: 't', mode: 'polling' });

      expect(testFn).toHaveBeenCalledOnce();
      expect(startFn).not.toHaveBeenCalled();
    });

    it('returns { ok: false } when adapter.testConnection() returns error', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      const { TelegramAdapter: TgMock } = await import('@dorkos/relay');
      vi.mocked(TgMock).mockImplementationOnce((id: string) => ({
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
      }));

      const result = await manager.testConnection('telegram', {
        token: 'bad-token',
        mode: 'polling',
      });

      expect(result).toEqual({ ok: false, error: 'Unauthorized' });
    });

    it('falls back to start/stop when adapter has no testConnection()', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      const startFn = vi.fn().mockResolvedValue(undefined);
      const stopFn = vi.fn().mockResolvedValue(undefined);
      const { TelegramAdapter: TgMock } = await import('@dorkos/relay');
      vi.mocked(TgMock).mockImplementationOnce((id: string) => ({
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
        // No testConnection — forces fallback to start/stop
      }));

      const result = await manager.testConnection('telegram', { token: 't', mode: 'polling' });

      expect(result).toEqual({ ok: true });
      expect(startFn).toHaveBeenCalledOnce();
      expect(stopFn).toHaveBeenCalledOnce();
    });

    it('returns { ok: false } for unknown adapter type', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      const result = await manager.testConnection('nonexistent', {});

      expect(result).toEqual({ ok: false, error: 'Unknown adapter type: nonexistent' });
    });

    it('always calls stop() on the adapter in fallback path, even on failure', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      const stopFn = vi.fn().mockResolvedValue(undefined);
      const { TelegramAdapter: TgMock } = await import('@dorkos/relay');
      vi.mocked(TgMock).mockImplementationOnce((id: string) => ({
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
        // No testConnection — forces fallback
      }));

      await manager.testConnection('telegram', { token: 't', mode: 'polling' });

      expect(stopFn).toHaveBeenCalledOnce();
    });

    it('does NOT register the adapter in the registry', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();
      vi.clearAllMocks();

      await manager.testConnection('telegram', { token: 't', mode: 'polling' });

      expect(registry.register).not.toHaveBeenCalled();
    });

    it('times out after 15 seconds if testConnection() hangs', async () => {
      vi.useFakeTimers();
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      const stopFn = vi.fn().mockResolvedValue(undefined);
      const { TelegramAdapter: TgMock } = await import('@dorkos/relay');
      vi.mocked(TgMock).mockImplementationOnce((id: string) => ({
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
      }));

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
  });

  describe('addAdapter()', () => {
    it('adds a new adapter to configs and persists', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
      await manager.initialize();
      vi.clearAllMocks();

      await manager.addAdapter('webhook', 'wh-new', {
        inbound: { subject: 'relay.webhook.test', secret: 'secret-16-chars!!' },
        outbound: { url: 'https://example.com', secret: 'secret-16-chars!!' },
      });

      expect(writeFile).toHaveBeenCalledWith(
        configPath,
        expect.stringContaining('"wh-new"'),
        'utf-8',
      );
      const adapters = manager.listAdapters();
      expect(adapters).toHaveLength(1);
      expect(adapters[0].config.id).toBe('wh-new');
    });

    it('starts the adapter if enabled', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
      await manager.initialize();
      vi.clearAllMocks();

      await manager.addAdapter('webhook', 'wh-new', {
        inbound: { subject: 'relay.webhook.test', secret: 'secret-16-chars!!' },
        outbound: { url: 'https://example.com', secret: 'secret-16-chars!!' },
      });

      expect(registry.register).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'wh-new' }),
      );
    });

    it('does not start the adapter if disabled', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
      await manager.initialize();
      vi.clearAllMocks();

      await manager.addAdapter('webhook', 'wh-new', {
        inbound: { subject: 'relay.webhook.test', secret: 'secret-16-chars!!' },
        outbound: { url: 'https://example.com', secret: 'secret-16-chars!!' },
      }, false);

      expect(registry.register).not.toHaveBeenCalled();
    });

    it('rejects duplicate IDs with DUPLICATE_ID', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      await expect(
        manager.addAdapter('webhook', 'tg-main', {}),
      ).rejects.toThrow(AdapterError);

      try {
        await manager.addAdapter('webhook', 'tg-main', {});
      } catch (err) {
        expect((err as AdapterError).code).toBe('DUPLICATE_ID');
      }
    });

    it('rejects unknown adapter types with UNKNOWN_TYPE', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
      await manager.initialize();

      await expect(
        manager.addAdapter('nonexistent-type', 'new-id', {}),
      ).rejects.toThrow(AdapterError);

      try {
        await manager.addAdapter('nonexistent-type', 'new-id', {});
      } catch (err) {
        expect((err as AdapterError).code).toBe('UNKNOWN_TYPE');
      }
    });

    it('rejects second instance of non-multiInstance type', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      // telegram is non-multiInstance, tg-main already exists
      await expect(
        manager.addAdapter('telegram', 'tg-second', { token: 'tok', mode: 'polling' }),
      ).rejects.toThrow(AdapterError);

      try {
        await manager.addAdapter('telegram', 'tg-second', { token: 'tok', mode: 'polling' });
      } catch (err) {
        expect((err as AdapterError).code).toBe('MULTI_INSTANCE_DENIED');
      }
    });

    it('allows second instance of multiInstance type (webhook)', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      // webhook is multiInstance, wh-github already exists
      await expect(
        manager.addAdapter('webhook', 'wh-second', {
          inbound: { subject: 'relay.webhook.test2', secret: 'secret-16-chars!!' },
          outbound: { url: 'https://example2.com', secret: 'secret-16-chars!!' },
        }),
      ).resolves.not.toThrow();

      const adapters = manager.listAdapters();
      const whIds = adapters.filter((a) => a.config.type === 'webhook').map((a) => a.config.id);
      expect(whIds).toContain('wh-github');
      expect(whIds).toContain('wh-second');
    });
  });

  describe('removeAdapter()', () => {
    it('stops, removes from config, persists', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();
      vi.clearAllMocks();

      await manager.removeAdapter('tg-main');

      expect(registry.unregister).toHaveBeenCalledWith('tg-main');
      expect(writeFile).toHaveBeenCalled();
      const adapters = manager.listAdapters();
      expect(adapters.find((a) => a.config.id === 'tg-main')).toBeUndefined();
    });

    it('returns NOT_FOUND for unknown IDs', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

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
      await manager.initialize();

      try {
        await manager.removeAdapter('claude-code');
      } catch (err) {
        expect(err).toBeInstanceOf(AdapterError);
        expect((err as AdapterError).code).toBe('REMOVE_BUILTIN_DENIED');
      }
    });
  });

  describe('updateConfig()', () => {
    it('merges new config and persists', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();
      vi.clearAllMocks();

      await manager.updateConfig('tg-main', { token: 'new-token', mode: 'webhook' });

      expect(writeFile).toHaveBeenCalled();
    });

    it('preserves password fields when empty string submitted', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      // Update with empty token (password field) — should preserve original
      await manager.updateConfig('tg-main', { token: '', mode: 'webhook' });

      const adapter = manager.getAdapter('tg-main');
      const config = adapter!.config.config as Record<string, unknown>;
      expect(config.token).toBe('bot-token-123');
      expect(config.mode).toBe('webhook');
    });

    it('preserves password fields when *** submitted', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      await manager.updateConfig('tg-main', { token: '***', mode: 'webhook' });

      const adapter = manager.getAdapter('tg-main');
      const config = adapter!.config.config as Record<string, unknown>;
      expect(config.token).toBe('bot-token-123');
    });

    it('preserves nested password fields (e.g., inbound.secret)', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();

      // Update wh-github with empty nested secrets — should preserve originals
      await manager.updateConfig('wh-github', {
        inbound: { subject: 'relay.webhook.new', secret: '' },
        outbound: { url: 'https://new.com', secret: '***' },
      });

      const adapter = manager.getAdapter('wh-github');
      const config = adapter!.config.config as Record<string, Record<string, unknown>>;
      expect(config.inbound.secret).toBe('a-very-long-secret-16');
      expect(config.outbound.secret).toBe('another-long-secret-16');
      expect(config.inbound.subject).toBe('relay.webhook.new');
      expect(config.outbound.url).toBe('https://new.com');
    });

    it('restarts adapter after config change', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();
      vi.clearAllMocks();

      // tg-main is enabled and running
      await manager.updateConfig('tg-main', { token: 'new-token', mode: 'polling' });

      // Should unregister and re-register
      expect(registry.unregister).toHaveBeenCalledWith('tg-main');
      expect(registry.register).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tg-main' }),
      );
    });

    it('does not restart disabled adapter after config change', async () => {
      vi.mocked(readFile).mockResolvedValue(VALID_CONFIG);
      await manager.initialize();
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
      await manager.initialize();

      try {
        await manager.updateConfig('nonexistent', { key: 'value' });
      } catch (err) {
        expect(err).toBeInstanceOf(AdapterError);
        expect((err as AdapterError).code).toBe('NOT_FOUND');
      }
    });
  });

  describe('error handling', () => {
    it('missing config file -> empty adapter list, no crash', async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      vi.mocked(readFile).mockRejectedValue(err);

      await manager.initialize();

      expect(manager.listAdapters()).toHaveLength(0);
      expect(registry.register).not.toHaveBeenCalled();
    });

    it('malformed config -> log warning, empty adapter list', async () => {
      vi.mocked(readFile).mockResolvedValue('{ invalid json !!!');

      await manager.initialize();

      expect(manager.listAdapters()).toHaveLength(0);
    });

    it('invalid schema -> log warning, empty adapter list', async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({
        adapters: [{ id: '', type: 'unknown-type', enabled: true, config: {} }],
      }));

      await manager.initialize();

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

      await manager.initialize();

      // Both adapters should have been attempted
      expect(registry.register).toHaveBeenCalledTimes(2);
    });
  });
});
