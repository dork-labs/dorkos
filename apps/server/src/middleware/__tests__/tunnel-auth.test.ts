import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Hoist mock so it's available to vi.mock factories (which are hoisted)
const mockConfigManager = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: mockConfigManager,
}));

vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { tunnelPasscodeAuth } from '../tunnel-auth.js';

interface MockReqOptions {
  hostname?: string;
  path?: string;
  session?: { tunnelAuthenticated?: boolean } | null;
}

function createMockReq(options: MockReqOptions = {}): Partial<Request> {
  return {
    hostname: options.hostname ?? 'localhost',
    path: options.path ?? '/api/sessions',
    session: (options.session ?? null) as Request['session'],
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

describe('tunnelPasscodeAuth', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
    mockConfigManager.get.mockReset();
  });

  it('passes through for localhost requests', () => {
    mockConfigManager.get.mockReturnValue({ passcodeEnabled: true, passcodeHash: 'hash' });
    const req = createMockReq({ hostname: 'localhost' });
    const res = createMockRes();

    tunnelPasscodeAuth(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('passes through for 127.0.0.1 requests', () => {
    mockConfigManager.get.mockReturnValue({ passcodeEnabled: true, passcodeHash: 'hash' });
    const req = createMockReq({ hostname: '127.0.0.1' });
    const res = createMockRes();

    tunnelPasscodeAuth(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('passes through when passcode is not enabled', () => {
    mockConfigManager.get.mockReturnValue({ passcodeEnabled: false, passcodeHash: null });
    const req = createMockReq({ hostname: 'my-tunnel.ngrok-free.app' });
    const res = createMockRes();

    tunnelPasscodeAuth(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('passes through when passcode hash is null', () => {
    mockConfigManager.get.mockReturnValue({ passcodeEnabled: true, passcodeHash: null });
    const req = createMockReq({ hostname: 'my-tunnel.ngrok-free.app' });
    const res = createMockRes();

    tunnelPasscodeAuth(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('passes through for /api/tunnel/passcode/verify', () => {
    mockConfigManager.get.mockReturnValue({ passcodeEnabled: true, passcodeHash: 'hash' });
    const req = createMockReq({
      hostname: 'my-tunnel.ngrok-free.app',
      path: '/api/tunnel/passcode/verify',
    });
    const res = createMockRes();

    tunnelPasscodeAuth(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('passes through for /api/tunnel/passcode/session', () => {
    mockConfigManager.get.mockReturnValue({ passcodeEnabled: true, passcodeHash: 'hash' });
    const req = createMockReq({
      hostname: 'my-tunnel.ngrok-free.app',
      path: '/api/tunnel/passcode/session',
    });
    const res = createMockRes();

    tunnelPasscodeAuth(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('passes through for /api/health', () => {
    mockConfigManager.get.mockReturnValue({ passcodeEnabled: true, passcodeHash: 'hash' });
    const req = createMockReq({
      hostname: 'my-tunnel.ngrok-free.app',
      path: '/api/health',
    });
    const res = createMockRes();

    tunnelPasscodeAuth(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('passes through for /assets/ paths', () => {
    mockConfigManager.get.mockReturnValue({ passcodeEnabled: true, passcodeHash: 'hash' });
    const req = createMockReq({
      hostname: 'my-tunnel.ngrok-free.app',
      path: '/assets/index-abc123.js',
    });
    const res = createMockRes();

    tunnelPasscodeAuth(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('passes through for /favicon.ico', () => {
    mockConfigManager.get.mockReturnValue({ passcodeEnabled: true, passcodeHash: 'hash' });
    const req = createMockReq({
      hostname: 'my-tunnel.ngrok-free.app',
      path: '/favicon.ico',
    });
    const res = createMockRes();

    tunnelPasscodeAuth(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('returns 401 for tunnel requests without valid session', () => {
    mockConfigManager.get.mockReturnValue({ passcodeEnabled: true, passcodeHash: 'hash' });
    const req = createMockReq({
      hostname: 'my-tunnel.ngrok-free.app',
      path: '/api/sessions',
      session: null,
    });
    const res = createMockRes();

    tunnelPasscodeAuth(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Passcode required' });
  });

  it('returns 401 for tunnel requests with unauthenticated session', () => {
    mockConfigManager.get.mockReturnValue({ passcodeEnabled: true, passcodeHash: 'hash' });
    const req = createMockReq({
      hostname: 'my-tunnel.ngrok-free.app',
      path: '/api/sessions',
      session: { tunnelAuthenticated: false },
    });
    const res = createMockRes();

    tunnelPasscodeAuth(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Passcode required' });
  });

  it('passes through for tunnel requests with authenticated session', () => {
    mockConfigManager.get.mockReturnValue({ passcodeEnabled: true, passcodeHash: 'hash' });
    const req = createMockReq({
      hostname: 'my-tunnel.ngrok-free.app',
      path: '/api/sessions',
      session: { tunnelAuthenticated: true },
    });
    const res = createMockRes();

    tunnelPasscodeAuth(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });
});
