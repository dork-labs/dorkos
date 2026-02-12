import { describe, it, expect, vi } from 'vitest';
import { errorHandler } from '../error-handler.js';
import type { Request, Response, NextFunction } from 'express';

describe('errorHandler', () => {
  const mockReq = {} as Request;
  const mockNext = vi.fn() as NextFunction;

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

    // Suppress console.error in tests
    vi.spyOn(console, 'error').mockImplementation(() => {});

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

    vi.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(error, mockReq, res, mockNext);

    expect(res.json).toHaveBeenCalledWith({
      error: 'Internal Server Error',
      code: 'INTERNAL_ERROR',
    });
  });

  it('logs the error to console', () => {
    const res = createMockRes();
    const error = new Error('Log me');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    errorHandler(error, mockReq, res, mockNext);

    expect(consoleSpy).toHaveBeenCalledWith(
      '[Gateway Error]',
      'Log me',
      expect.any(String)
    );
  });
});
