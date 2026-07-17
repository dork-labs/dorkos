import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { errorHandler } from '../error-handler.js';
import type { Request, Response, NextFunction } from 'express';

vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
  initLogger: vi.fn(),
}));

describe('errorHandler', () => {
  const mockReq = {} as Request;
  const mockNext = vi.fn() as NextFunction;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure non-production so error messages are revealed (not masked)
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  function createMockRes() {
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    return res;
  }

  it('returns 500 with error message', () => {
    const res = createMockRes();
    const error = new Error('Something broke');

    errorHandler(error, mockReq, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Something broke',
      code: 'INTERNAL_ERROR',
    });
  });

  it('falls back to Internal Server Error for empty message', () => {
    const res = createMockRes();
    const error = new Error('');

    errorHandler(error, mockReq, res, mockNext);

    expect(res.json).toHaveBeenCalledWith({
      error: 'Internal Server Error',
      code: 'INTERNAL_ERROR',
    });
  });

  it('logs the error via logger', async () => {
    const { logger } = await import('../../lib/logger.js');
    const res = createMockRes();
    const error = new Error('Log me');

    errorHandler(error, mockReq, res, mockNext);

    expect(logger.error).toHaveBeenCalledWith('[DorkOS Error]', 'Log me', expect.any(String));
  });

  it('delegates to next(err) instead of writing a body when headers are already sent', async () => {
    // Simulates a rejection on an SSE-style response (e.g. the durable session
    // events stream) that fires AFTER the handler has already flushed headers.
    // Express 5 forwards such rejections here natively; writing res.json() at
    // that point would throw ERR_HTTP_HEADERS_SENT, so the guard must delegate
    // to Express's default handler (via next(err)) instead of responding.
    const { logger } = await import('../../lib/logger.js');
    const res = createMockRes();
    Object.defineProperty(res, 'headersSent', { value: true });
    const error = new Error('post-flush rejection');

    expect(() => errorHandler(error, mockReq, res, mockNext)).not.toThrow();

    expect(mockNext).toHaveBeenCalledWith(error);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
