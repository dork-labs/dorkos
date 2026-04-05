import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn(),
  },
}));

import { requireMcpEnabled } from '../mcp-enabled.js';
import { configManager } from '../../services/core/config-manager.js';

function createMockReq(): Partial<Request> {
  return {};
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

describe('requireMcpEnabled', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
    vi.mocked(configManager.get).mockReturnValue(undefined);
  });

  it('calls next() when mcp.enabled is true', () => {
    vi.mocked(configManager.get).mockReturnValue({
      enabled: true,
      apiKey: null,
      rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
    });
    const req = createMockReq();
    const res = createMockRes();
    requireMcpEnabled(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() when mcp config is undefined (default enabled)', () => {
    vi.mocked(configManager.get).mockReturnValue(undefined);
    const req = createMockReq();
    const res = createMockRes();
    requireMcpEnabled(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 503 with JSON-RPC error when mcp.enabled is false', () => {
    vi.mocked(configManager.get).mockReturnValue({
      enabled: false,
      apiKey: null,
      rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
    });
    const req = createMockReq();
    const res = createMockRes();
    requireMcpEnabled(req as Request, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'External MCP access is disabled.' },
      id: null,
    });
  });

  it('reads from the "mcp" config key', () => {
    requireMcpEnabled(createMockReq() as Request, createMockRes() as Response, next);
    expect(configManager.get).toHaveBeenCalledWith('mcp');
  });
});
