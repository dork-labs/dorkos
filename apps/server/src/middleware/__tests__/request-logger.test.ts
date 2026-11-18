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

  // Security condition 4 (DOR-4321): a video link's ticket is its credential.
  it('writes a video link as its route, never its ticket', () => {
    const ticket = 'Ab0_-'.repeat(8) + 'xyz';
    logRequest('GET', `/api/extensions/media/${ticket}`, 206, 2);
    logRequest('GET', `/api/extensions/media/${ticket}`, 404, 2);

    const lines = [...vi.mocked(logger.debug).mock.calls, ...vi.mocked(logger.warn).mock.calls];
    expect(lines).toHaveLength(2);
    for (const [fields] of lines as [Record<string, unknown>, string][]) {
      expect(fields.path).toBe('/api/extensions/media/[ticket]');
    }
    expect(JSON.stringify(lines)).not.toContain(ticket);
  });
});
