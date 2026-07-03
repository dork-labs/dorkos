import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock dependencies before importing the router
vi.mock('../../services/core/config-manager.js', () => {
  const store: Record<string, unknown> = {};
  return {
    configManager: {
      get: vi.fn((key: string) => store[key]),
      set: vi.fn((key: string, value: unknown) => {
        store[key] = value;
      }),
      getAll: vi.fn(() => ({ version: 1, ...store })),
    },
    initConfigManager: vi.fn(),
  };
});

vi.mock('../../env.js', () => ({
  env: {
    DORKOS_PORT: 6242,
    MCP_API_KEY: undefined as string | undefined,
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: {
      enabled: false,
      connected: false,
      url: null,
      port: null,
      startedAt: null,
      authEnabled: false,
      tokenConfigured: false,
      domain: null,
      passcodeEnabled: false,
    },
  },
}));

vi.mock('../../services/runtimes/claude-code/sdk/sdk-utils.js', () => ({
  resolveClaudeCliPath: vi.fn(() => null),
}));

vi.mock('../../services/core/update-checker.js', () => ({
  getLatestVersion: vi.fn(() => null),
}));

vi.mock('../../services/tasks/task-state.js', () => ({
  isTasksEnabled: vi.fn(() => false),
  getTasksInitError: vi.fn(() => undefined),
}));

vi.mock('../../services/relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn(() => false),
  getRelayInitError: vi.fn(() => undefined),
}));

vi.mock('../../services/mesh/mesh-state.js', () => ({
  getMeshInitError: vi.fn(() => undefined),
}));

vi.mock('../../lib/boundary.js', () => ({
  getBoundary: vi.fn(() => '/Users/test'),
}));

vi.mock('../../lib/version.js', () => ({
  SERVER_VERSION: '0.0.0-test',
  IS_DEV_BUILD: true,
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  logError: vi.fn((err: unknown) => ({ err })),
}));

// The auth barrel pulls in Better Auth + the DB adapter; mock the single reader
// the config route uses so the router imports cleanly without a live auth instance.
vi.mock('../../services/core/auth/index.js', () => ({
  hasAnyApiKey: vi.fn(() => false),
}));

import configRouter from '../config.js';
import { configManager } from '../../services/core/config-manager.js';
import { env } from '../../env.js';
import { hasAnyApiKey } from '../../services/core/auth/index.js';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
  return app;
}

describe('Config MCP endpoints', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the config store by clearing mock return values
    vi.mocked(configManager.get).mockReturnValue(undefined);
    (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = undefined;
    vi.mocked(hasAnyApiKey).mockReturnValue(false);
    // Set DORK_HOME for the GET handler
    process.env.DORK_HOME = '/tmp/dork-test';
    app = createTestApp();
  });

  describe('GET /api/config — mcp section', () => {
    it('returns mcp section with defaults when no key configured', async () => {
      const res = await request(app).get('/api/config').expect(200);
      expect(res.body.mcp).toBeDefined();
      expect(res.body.mcp.enabled).toBe(true);
      expect(res.body.mcp.authConfigured).toBe(false);
      expect(res.body.mcp.authSource).toBe('none');
      expect(res.body.mcp.endpoint).toBe('http://localhost:6242/mcp');
      expect(res.body.mcp.rateLimit).toEqual({
        enabled: true,
        maxPerWindow: 60,
        windowSecs: 60,
      });
    });

    it('returns authSource "env" when MCP_API_KEY env var is set', async () => {
      (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'env-secret';
      const res = await request(app).get('/api/config').expect(200);
      expect(res.body.mcp.authConfigured).toBe(true);
      expect(res.body.mcp.authSource).toBe('env');
    });

    it('returns authSource "user-keys" when per-user Better Auth keys exist', async () => {
      vi.mocked(hasAnyApiKey).mockReturnValue(true);
      const res = await request(app).get('/api/config').expect(200);
      expect(res.body.mcp.authConfigured).toBe(true);
      expect(res.body.mcp.authSource).toBe('user-keys');
    });

    it('returns authSource "user-keys" while a not-yet-seeded legacy apiKey lingers', async () => {
      vi.mocked(configManager.get).mockImplementation((key: string) => {
        if (key === 'mcp')
          return {
            enabled: true,
            apiKey: 'dork_mcp_legacy',
            rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
          };
        return undefined;
      });
      const res = await request(app).get('/api/config').expect(200);
      expect(res.body.mcp.authConfigured).toBe(true);
      expect(res.body.mcp.authSource).toBe('user-keys');
    });

    it('prefers authSource "env" over user keys when MCP_API_KEY is set', async () => {
      (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'env-secret';
      vi.mocked(hasAnyApiKey).mockReturnValue(true);
      const res = await request(app).get('/api/config').expect(200);
      expect(res.body.mcp.authSource).toBe('env');
    });
  });

  describe('removed key-management endpoints', () => {
    it('no longer exposes POST /api/config/mcp/generate-key', async () => {
      await request(app).post('/api/config/mcp/generate-key').expect(404);
    });

    it('no longer exposes DELETE /api/config/mcp/api-key', async () => {
      await request(app).delete('/api/config/mcp/api-key').expect(404);
    });
  });
});
