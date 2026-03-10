import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Hoist mock so it's available to vi.mock factories (which are hoisted)
const mockTunnelManager = vi.hoisted(() => ({
  status: { url: null as string | null },
}));

// Mock env and tunnelManager before importing the middleware
vi.mock('../../env.js', () => ({
  env: {
    DORKOS_PORT: 4242,
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: mockTunnelManager,
}));

import { validateMcpOrigin } from '../mcp-origin.js';

function createMockReq(origin?: string): Partial<Request> {
  return {
    headers: origin ? { origin } : {},
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

describe('validateMcpOrigin', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
    mockTunnelManager.status.url = null;
  });

  it('allows requests with no Origin header (non-browser clients)', () => {
    const req = createMockReq();
    const res = createMockRes();
    validateMcpOrigin(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('allows requests from http://localhost:{port}', () => {
    const req = createMockReq('http://localhost:4242');
    const res = createMockRes();
    validateMcpOrigin(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('allows requests from http://127.0.0.1:{port}', () => {
    const req = createMockReq('http://127.0.0.1:4242');
    const res = createMockRes();
    validateMcpOrigin(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('allows requests from tunnel origin when tunnel is active', () => {
    mockTunnelManager.status.url = 'https://my-tunnel.ngrok-free.app';
    const req = createMockReq('https://my-tunnel.ngrok-free.app');
    const res = createMockRes();
    validateMcpOrigin(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects requests from unknown origins with 403', () => {
    const req = createMockReq('https://evil.com');
    const res = createMockRes();
    validateMcpOrigin(req as Request, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32002, message: 'Origin https://evil.com not allowed' },
      id: null,
    });
  });

  it('rejects requests from localhost with wrong port', () => {
    const req = createMockReq('http://localhost:9999');
    const res = createMockRes();
    validateMcpOrigin(req as Request, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('rejects tunnel-like origins when tunnel is not active', () => {
    // tunnelManager.status.url is null (default in beforeEach)
    const req = createMockReq('https://some-tunnel.ngrok-free.app');
    const res = createMockRes();
    validateMcpOrigin(req as Request, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
