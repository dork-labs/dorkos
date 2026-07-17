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

// The local-token module reads env/fs at import; mock the two accessors the
// config route consults so the DTO + rotate route are exercised without touching
// the real 0600 token file.
vi.mock('../../services/core/auth/mcp-local-token.js', () => ({
  getMcpLocalToken: vi.fn(() => null),
  rotateMcpLocalToken: vi.fn(() => 'dork_mcp_local_rotated'),
}));

vi.mock('../../lib/dork-home.js', () => ({
  resolveDorkHome: vi.fn(() => '/tmp/dork-test'),
}));

import configRouter from '../config.js';
import { configManager } from '../../services/core/config-manager.js';
import { env } from '../../env.js';
import { hasAnyApiKey } from '../../services/core/auth/index.js';
import { getMcpLocalToken, rotateMcpLocalToken } from '../../services/core/auth/mcp-local-token.js';

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
    // Default to no local token — the degenerate can't-generate fallback. Cases
    // that exercise the local-token path override this per-test.
    vi.mocked(getMcpLocalToken).mockReturnValue(null);
    vi.mocked(rotateMcpLocalToken).mockReturnValue('dork_mcp_local_rotated');
    // Set DORK_HOME for the GET handler
    process.env.DORK_HOME = '/tmp/dork-test';
    app = createTestApp();
  });

  describe('GET /api/config — mcp section', () => {
    it('returns authSource "none" as the degenerate fallback when no token could be generated', async () => {
      // Purpose: with no env key, no user keys, and no local token (the
      // can't-generate fallback that should not occur in a normal boot), the
      // surface reports 'none' / not-configured and emits no token.
      const res = await request(app).get('/api/config').expect(200);
      expect(res.body.mcp).toBeDefined();
      expect(res.body.mcp.enabled).toBe(true);
      expect(res.body.mcp.authConfigured).toBe(false);
      expect(res.body.mcp.authSource).toBe('none');
      expect(res.body.mcp.localToken).toBeNull();
      expect(res.body.mcp.endpoint).toBe('http://localhost:6242/mcp');
      expect(res.body.mcp.rateLimit).toEqual({
        enabled: true,
        maxPerWindow: 60,
        windowSecs: 60,
      });
    });

    it('returns authSource "local-token" and the token in login-off mode with no env key', async () => {
      // Purpose: the common login-off boot — a per-instance local token gates
      // the surface, so authSource is 'local-token', authConfigured is true, and
      // the token is emitted for the settings tab to paste.
      vi.mocked(getMcpLocalToken).mockReturnValue('dork_mcp_local_abc123');
      const res = await request(app).get('/api/config').expect(200);
      expect(res.body.mcp.authSource).toBe('local-token');
      expect(res.body.mcp.authConfigured).toBe(true);
      expect(res.body.mcp.localToken).toBe('dork_mcp_local_abc123');
    });

    it('returns authSource "env" and no token when MCP_API_KEY env var is set', async () => {
      // Purpose: an env override is the bearer clients use, so the local token
      // never applies and is never emitted, even if one somehow resolved.
      (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'env-secret';
      vi.mocked(getMcpLocalToken).mockReturnValue('dork_mcp_local_abc123');
      const res = await request(app).get('/api/config').expect(200);
      expect(res.body.mcp.authConfigured).toBe(true);
      expect(res.body.mcp.authSource).toBe('env');
      expect(res.body.mcp.localToken).toBeNull();
    });

    it('returns authSource "user-keys" and no token when per-user Better Auth keys exist', async () => {
      // Purpose: login-on / per-user keys take precedence over the local token,
      // which is inactive and never emitted in that mode (ADR-0320).
      vi.mocked(hasAnyApiKey).mockReturnValue(true);
      const res = await request(app).get('/api/config').expect(200);
      expect(res.body.mcp.authConfigured).toBe(true);
      expect(res.body.mcp.authSource).toBe('user-keys');
      expect(res.body.mcp.localToken).toBeNull();
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

  describe('POST /api/config/mcp/rotate-token', () => {
    it('rotates and returns a new local token in login-off mode with no env key', async () => {
      // Purpose: the happy path — a fresh token is minted and returned so the
      // settings tab can show the new value.
      vi.mocked(rotateMcpLocalToken).mockReturnValue('dork_mcp_local_newvalue');
      const res = await request(app).post('/api/config/mcp/rotate-token').expect(200);
      expect(res.body.localToken).toBe('dork_mcp_local_newvalue');
      expect(rotateMcpLocalToken).toHaveBeenCalledWith('/tmp/dork-test');
    });

    it('409s when MCP_API_KEY is set (the env override is the bearer)', async () => {
      // Purpose: the local token does not apply under an env override, so
      // rotating it is refused rather than minting a token nothing honors.
      (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'env-secret';
      const res = await request(app).post('/api/config/mcp/rotate-token').expect(409);
      expect(res.body.error).toMatch(/MCP_API_KEY/);
      expect(rotateMcpLocalToken).not.toHaveBeenCalled();
    });

    it('409s when login is on (per-user keys are the credential)', async () => {
      // Purpose: with login on the local token is inactive (ADR-0320), so a
      // rotate request is refused.
      vi.mocked(configManager.get).mockImplementation((key: string) =>
        key === 'auth' ? { enabled: true } : undefined
      );
      const res = await request(app).post('/api/config/mcp/rotate-token').expect(409);
      expect(res.body.error).toMatch(/login is on/i);
      expect(rotateMcpLocalToken).not.toHaveBeenCalled();
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
