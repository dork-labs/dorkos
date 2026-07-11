import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mock env before importing the middleware.
vi.mock('../../env.js', () => ({
  env: {
    MCP_API_KEY: undefined as string | undefined,
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn(),
  },
}));

// The shared credential verifier (session cookie → per-user Better Auth API key).
// Mocked here so these unit tests can drive the per-user path without a live auth
// instance; the real end-to-end path is covered in mcp-auth.integration.test.ts.
vi.mock('../../services/core/auth/index.js', () => ({
  verifyRequestAuth: vi.fn(),
}));

import { mcpApiKeyAuth } from '../mcp-auth.js';
import { env } from '../../env.js';
import { configManager } from '../../services/core/config-manager.js';
import { verifyRequestAuth } from '../../services/core/auth/index.js';

const JSON_RPC_401 = {
  jsonrpc: '2.0',
  error: {
    code: -32001,
    message: 'Unauthorized. Provide a valid API key via Authorization: Bearer <key>.',
  },
  id: null,
};

function createMockReq(authHeader?: string): Partial<Request> {
  return { headers: authHeader ? { authorization: authHeader } : {} };
}

function createMockRes(): Partial<Response> & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn().mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn().mockImplementation((data: unknown) => {
    res.body = data;
    return res;
  }) as unknown as Response['json'];
  return res;
}

/** Mock configManager.get keyed by the two keys the middleware reads. */
function mockConfig(opts: { mcpApiKey?: string | null; authEnabled?: boolean }): void {
  vi.mocked(configManager.get).mockImplementation((key: string) => {
    if (key === 'mcp') return { apiKey: opts.mcpApiKey ?? null } as never;
    if (key === 'auth') return { enabled: opts.authEnabled ?? false } as never;
    return undefined as never;
  });
}

describe('mcpApiKeyAuth', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
    (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = undefined;
    vi.mocked(configManager.get).mockReturnValue(undefined);
    // No identity by default — the per-user path is opt-in per test.
    vi.mocked(verifyRequestAuth).mockResolvedValue(null);
  });

  describe('env MCP_API_KEY static override', () => {
    it('passes when the Bearer token matches MCP_API_KEY', async () => {
      (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'test-secret-key';
      const res = createMockRes();
      await mcpApiKeyAuth(
        createMockReq('Bearer test-secret-key') as Request,
        res as Response,
        next
      );
      expect(next).toHaveBeenCalled();
    });

    it('returns JSON-RPC 401 when MCP_API_KEY is set but no Authorization header', async () => {
      (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'test-secret-key';
      const res = createMockRes();
      await mcpApiKeyAuth(createMockReq() as Request, res as Response, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual(JSON_RPC_401);
    });

    it('returns 401 when the token does not match MCP_API_KEY', async () => {
      (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'correct-key';
      const res = createMockRes();
      await mcpApiKeyAuth(createMockReq('Bearer wrong-key') as Request, res as Response, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 when the scheme is not Bearer', async () => {
      (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'test-key';
      const res = createMockRes();
      await mcpApiKeyAuth(createMockReq('Basic test-key') as Request, res as Response, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });

    it('rejects a same-length wrong token (constant-time compare stays closed)', async () => {
      (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'abcdef';
      const res = createMockRes();
      await mcpApiKeyAuth(createMockReq('Bearer ghijkl') as Request, res as Response, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });

    it('env override wins even when a per-user identity would also resolve', async () => {
      (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'env-key';
      vi.mocked(verifyRequestAuth).mockResolvedValue({ userId: 'u1' });
      const res = createMockRes();
      await mcpApiKeyAuth(createMockReq('Bearer env-key') as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('per-user Better Auth key / session (shared verifier)', () => {
    it('passes when verifyRequestAuth resolves an identity', async () => {
      vi.mocked(verifyRequestAuth).mockResolvedValue({ userId: 'owner-1' });
      const res = createMockRes();
      await mcpApiKeyAuth(createMockReq('Bearer some-user-key') as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
    });

    it('returns 401 for a revoked/invalid key when login is enabled', async () => {
      // Login on: a request that reaches here with no valid identity must 401.
      mockConfig({ authEnabled: true });
      vi.mocked(verifyRequestAuth).mockResolvedValue(null);
      const res = createMockRes();
      await mcpApiKeyAuth(createMockReq('Bearer revoked-key') as Request, res as Response, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual(JSON_RPC_401);
    });
  });

  describe('legacy config compat window', () => {
    it('accepts the not-yet-seeded config mcp.apiKey', async () => {
      mockConfig({ mcpApiKey: 'dork_mcp_legacy' });
      const res = createMockRes();
      await mcpApiKeyAuth(
        createMockReq('Bearer dork_mcp_legacy') as Request,
        res as Response,
        next
      );
      expect(next).toHaveBeenCalled();
    });

    it('rejects a wrong token while a legacy key is configured', async () => {
      mockConfig({ mcpApiKey: 'dork_mcp_legacy' });
      const res = createMockRes();
      await mcpApiKeyAuth(createMockReq('Bearer nope') as Request, res as Response, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });
  });

  describe('pass-through (nothing configured, login disabled)', () => {
    it('passes with no credentials when nothing requires auth', async () => {
      mockConfig({ mcpApiKey: null, authEnabled: false });
      const res = createMockRes();
      await mcpApiKeyAuth(createMockReq() as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
    });

    it('passes even with a stray auth header when nothing requires auth', async () => {
      mockConfig({ mcpApiKey: null, authEnabled: false });
      const res = createMockRes();
      await mcpApiKeyAuth(createMockReq('Bearer stray') as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
    });
  });
});
