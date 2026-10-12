import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logRequest } from '../request-logger.js';

vi.mock('../../lib/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

import { logger } from '../../lib/logger.js';

describe('logRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs method, path, status, and ms at debug for a success', () => {
    logRequest('POST', '/api/sessions', 201, 12);

    expect(logger.debug).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
    const [fields, msg] = vi.mocked(logger.debug).mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(msg).toBe('request');
    expect(fields).toEqual({ method: 'POST', path: '/api/sessions', status: 201, ms: 12 });
  });

  it('logs a 4xx or 5xx at warn, so it shows in production', () => {
    logRequest('GET', '/api/no-such-route', 404, 1);
    logRequest('GET', '/api/boom', 500, 1);

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('carries only the method, path, status and time: never a body or a header', () => {
    logRequest('GET', '/api/sessions', 200, 3);

    const [fields] = vi.mocked(logger.debug).mock.calls[0] as [Record<string, unknown>, string];
    expect(Object.keys(fields).sort()).toEqual(['method', 'ms', 'path', 'status']);
  });
});
