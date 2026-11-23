import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LAN_LINES_PER_MINUTE, logRequest, resetLanLineLimits } from '../request-logger.js';

vi.mock('../../lib/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
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

  // DOR-4736: every spelling that still routes.
  it.each([
    ['an encoded segment', (t: string) => `/api/extensions/m%65dia/${t}`],
    ['an upper-case segment', (t: string) => `/api/extensions/MEDIA/${t}`],
    ['doubled slashes', (t: string) => `/api/extensions//media//${t}`],
    ['an encoded slash', (t: string) => `/api/extensions/media%2F${t}`],
    ['a malformed sequence after it', (t: string) => `/api/extensions/m%65dia/${t}%ZZ`],
    ['another extensions route', (t: string) => `/api/extensions/app-x/files/${t}`],
  ])('never writes a ticket sent with %s', (_label, spell) => {
    const ticket = 'Zz9_-'.repeat(8) + 'abc';
    logRequest('GET', spell(ticket), 206, 2);
    const line = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(line).not.toContain(ticket);
    expect(line).toContain('[ticket]');
  });

  it('never writes a query string, which may hold a secret', () => {
    logRequest('GET', '/api/sessions?token=s3cret&cwd=/x', 200, 1);
    const [fields] = vi.mocked(logger.debug).mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.path).toBe('/api/sessions');
  });
});

// DOR-5042: a request from another device is always on record, with its address.
describe('logRequest for another device', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLanLineLimits();
  });

  it('says a request was cut off when its connection closed first', () => {
    logRequest('GET', '/api/events', 200, 900, '192.168.1.9', true);
    const [fields] = vi.mocked(logger.info).mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.aborted).toBe(true);
  });

  it("writes at most a minute's worth of lines per device, then says how many it held back", () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < LAN_LINES_PER_MINUTE + 5; i++)
        logRequest('GET', '/api/x', 403, 1, '192.168.1.66');
      logRequest('GET', '/api/x', 403, 1, '192.168.1.67');
      const lines = vi.mocked(logger.warn).mock.calls;
      expect(
        lines.filter((l) => (l[0] as { client?: string }).client === '192.168.1.66')
      ).toHaveLength(LAN_LINES_PER_MINUTE);
      expect(
        lines.filter((l) => (l[0] as { client?: string }).client === '192.168.1.67')
      ).toHaveLength(1);
      vi.advanceTimersByTime(60_000);
      logRequest('GET', '/api/x', 403, 1, '192.168.1.66');
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        { client: '192.168.1.66', held: 5 },
        'more requests from another device were not logged'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs an accepted request from the network at info, with the client address', () => {
    logRequest('GET', '/api/sessions?token=s3cret', 200, 4, '192.168.1.23');

    expect(logger.info).toHaveBeenCalledOnce();
    const [fields, msg] = vi.mocked(logger.info).mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe('request from another device');
    expect(fields).toEqual({
      method: 'GET',
      path: '/api/sessions',
      status: 200,
      ms: 4,
      client: '192.168.1.23',
    });
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('logs a refused request from the network at warn, with the client address', () => {
    logRequest('POST', '/api/sessions', 403, 1, '::ffff:10.0.0.7');
    const [fields] = vi.mocked(logger.warn).mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.client).toBe('::ffff:10.0.0.7');
    expect(logger.info).not.toHaveBeenCalled();
  });

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'adds no line for a request from this machine (%s)',
    (client) => {
      logRequest('GET', '/api/sessions', 200, 1, client);
      expect(logger.info).not.toHaveBeenCalled();
      const [fields] = vi.mocked(logger.debug).mock.calls[0] as [Record<string, unknown>, string];
      expect(fields).not.toHaveProperty('client');
    }
  );
});
