import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requestLogger } from '../request-logger.js';

vi.mock('../../lib/logger.js', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

import { logger } from '../../lib/logger.js';

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/api/sessions',
    ...overrides,
  } as Request;
}

function createMockRes(): Response {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    statusCode: 200,
    on(event: string, cb: () => void) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
      return this;
    },
    emit(event: string) {
      listeners[event]?.forEach((cb) => cb());
    },
  } as unknown as Response;
}

describe('requestLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls next immediately', () => {
    const next: NextFunction = vi.fn();
    requestLogger(createMockReq(), createMockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not log before response finishes', () => {
    requestLogger(createMockReq(), createMockRes(), vi.fn());
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('logs method, path, status, and ms on finish', () => {
    const res = createMockRes();
    res.statusCode = 201;
    requestLogger(createMockReq({ method: 'POST', path: '/api/sessions' }), res, vi.fn());

    res.emit('finish');

    expect(logger.debug).toHaveBeenCalledOnce();
    const [fields, msg] = vi.mocked(logger.debug).mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(msg).toBe('request');
    expect(fields.method).toBe('POST');
    expect(fields.path).toBe('/api/sessions');
    expect(fields.status).toBe(201);
    expect(typeof fields.ms).toBe('number');
  });

  it('does not log req.body or headers', () => {
    const req = createMockReq({
      body: { content: 'secret message' },
      headers: { authorization: 'Bearer token123' },
    });
    const res = createMockRes();
    requestLogger(req, res, vi.fn());
    res.emit('finish');

    const [fields] = vi.mocked(logger.debug).mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).not.toHaveProperty('body');
    expect(fields).not.toHaveProperty('headers');
    expect(fields).not.toHaveProperty('authorization');
    expect(JSON.stringify(fields)).not.toContain('secret');
    expect(JSON.stringify(fields)).not.toContain('token123');
  });

  it('records response time in ms', async () => {
    const res = createMockRes();
    requestLogger(createMockReq(), res, vi.fn());

    // Small delay to ensure ms > 0
    await new Promise((r) => setTimeout(r, 5));
    res.emit('finish');

    const [fields] = vi.mocked(logger.debug).mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.ms).toBeGreaterThanOrEqual(0);
  });
});
