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
});
