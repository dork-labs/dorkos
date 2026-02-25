import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdapterManager } from '../adapter-manager.js';
import type { AdapterRegistry, RelayAdapter, AdapterConfig, AdapterStatus } from '@dorkos/relay';

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

// Mock TelegramAdapter and WebhookAdapter
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
      deliver: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({
        state: 'connected',
        messageCount: { inbound: 0, outbound: 0 },
        errorCount: 0,
      }),
    })),
    WebhookAdapter: vi.fn().mockImplementation((id: string) => ({
      id,
      subjectPrefix: 'relay.webhook.test',
      displayName: `Webhook (${id})`,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      deliver: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({
        state: 'connected',
        messageCount: { inbound: 0, outbound: 0 },
        errorCount: 0,
      }),
      handleInbound: vi.fn().mockResolvedValue({ ok: true }),
    })),
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

describe('AdapterManager', () => {
  let manager: AdapterManager;
  let registry: ReturnType<typeof createMockRegistry>;
  const configPath = '/home/test/.dork/relay/adapters.json';

  beforeEach(() => {
    vi.clearAllMocks();
    registry = createMockRegistry();
    manager = new AdapterManager(registry, configPath);
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
      vi.mocked(registry.register).mockImplementation(async (adapter: RelayAdapter) => {
        callCount++;
        if (callCount === 1) throw new Error('Start failed');
      });

      await manager.initialize();

      // Both adapters should have been attempted
      expect(registry.register).toHaveBeenCalledTimes(2);
    });
  });
});
