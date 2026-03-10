import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mock env module before importing the middleware
vi.mock('../../env.js', () => ({
  env: {
    MCP_API_KEY: undefined as string | undefined,
  },
}));

import { mcpApiKeyAuth } from '../mcp-auth.js';
import { env } from '../../env.js';

function createMockReq(authHeader?: string): Partial<Request> {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  };
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

describe('mcpApiKeyAuth', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
    // Reset to no key by default
    (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = undefined;
  });

  it('calls next() when MCP_API_KEY is not set', () => {
    const req = createMockReq();
    const res = createMockRes();
    mcpApiKeyAuth(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next() when MCP_API_KEY is not set even with auth header', () => {
    const req = createMockReq('Bearer some-token');
    const res = createMockRes();
    mcpApiKeyAuth(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next() when valid Bearer token matches MCP_API_KEY', () => {
    (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'test-secret-key';
    const req = createMockReq('Bearer test-secret-key');
    const res = createMockRes();
    mcpApiKeyAuth(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 401 when MCP_API_KEY is set but no Authorization header', () => {
    (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'test-secret-key';
    const req = createMockReq();
    const res = createMockRes();
    mcpApiKeyAuth(req as Request, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized. Set Authorization: Bearer <MCP_API_KEY>.' },
      id: null,
    });
  });

  it('returns 401 when token does not match MCP_API_KEY', () => {
    (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'correct-key';
    const req = createMockReq('Bearer wrong-key');
    const res = createMockRes();
    mcpApiKeyAuth(req as Request, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when scheme is not Bearer', () => {
    (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'test-key';
    const req = createMockReq('Basic test-key');
    const res = createMockRes();
    mcpApiKeyAuth(req as Request, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when Authorization header has no space separator', () => {
    (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'test-key';
    const req = createMockReq('Bearertest-key');
    const res = createMockRes();
    mcpApiKeyAuth(req as Request, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
