import { beforeEach, describe, expect, it, vi } from 'vitest';

const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));
vi.mock('@/lib/newsletter/service', () => ({ confirm: confirmMock }));

import { CONFIRM_RATE_LIMIT, resetConfirmRateLimit } from '@/lib/newsletter/confirm-rate-limit';

import { GET } from '../route';

function get(token: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://dorkos.ai/api/newsletter/confirm?token=${token}`, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetConfirmRateLimit();
});

describe('GET /api/newsletter/confirm', () => {
  it('confirms and redirects to the success page', async () => {
    confirmMock.mockResolvedValueOnce('confirmed');
    const res = await GET(get('good-token'));
    expect(res.status).toBe(303);
    expect(confirmMock).toHaveBeenCalledWith('good-token');
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('/newsletter/confirmed');
    expect(loc).not.toContain('status=invalid');
  });

  it('redirects with status=invalid for a bad/expired token', async () => {
    confirmMock.mockResolvedValueOnce('invalid');
    const res = await GET(get('stale'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/newsletter/confirmed?status=invalid');
  });
});

describe('GET /api/newsletter/confirm rate limiting', () => {
  const ip = { 'x-real-ip': '203.0.113.20' };

  it('lets one IP through up to the limit, then answers 429', async () => {
    confirmMock.mockResolvedValue('confirmed');
    for (let i = 0; i < CONFIRM_RATE_LIMIT; i += 1) {
      expect((await GET(get(`tok-${i}`, ip))).status).toBe(303);
    }
    expect(confirmMock).toHaveBeenCalledTimes(CONFIRM_RATE_LIMIT);

    const blocked = await GET(get('tok-over', ip));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('600');
    // The throttled request never reaches the token lookup.
    expect(confirmMock).toHaveBeenCalledTimes(CONFIRM_RATE_LIMIT);
  });

  it('answers the 429 as a page a person can read, not JSON', async () => {
    confirmMock.mockResolvedValue('confirmed');
    for (let i = 0; i < CONFIRM_RATE_LIMIT; i += 1) await GET(get('tok', ip));

    const blocked = await GET(get('tok', ip));
    expect(blocked.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const body = await blocked.text();
    expect(body).toContain('<!doctype html>');
    expect(body).toContain('One moment');
    // Plain words about what to do next, not a machine-readable error code.
    expect(body).toContain('Wait a minute, then open it again');
  });

  it("does not charge one IP for another IP's attempts", async () => {
    confirmMock.mockResolvedValue('confirmed');
    for (let i = 0; i <= CONFIRM_RATE_LIMIT; i += 1) await GET(get('tok', ip));
    expect((await GET(get('tok', ip))).status).toBe(429);

    expect((await GET(get('tok', { 'x-real-ip': '203.0.113.21' }))).status).toBe(303);
  });

  it('charges invalid tokens too, so a token-guessing loop still gets throttled', async () => {
    confirmMock.mockResolvedValue('invalid');
    for (let i = 0; i < CONFIRM_RATE_LIMIT; i += 1) {
      expect((await GET(get(`guess-${i}`, ip))).status).toBe(303);
    }
    expect((await GET(get('guess-next', ip))).status).toBe(429);
  });
});
