import { beforeEach, describe, expect, it, vi } from 'vitest';

const { subscribeMock } = vi.hoisted(() => ({
  subscribeMock: vi.fn().mockResolvedValue('created'),
}));
vi.mock('@/lib/newsletter/service', () => ({ subscribe: subscribeMock }));

import {
  SUBSCRIBE_RATE_LIMIT,
  resetSubscribeRateLimit,
} from '@/lib/newsletter/subscribe-rate-limit';

import { POST } from '../route';

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://dorkos.ai/api/newsletter/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** A distinct IP per test, so one test's spent quota can never bleed into another. */
let ipCounter = 0;
function freshIp(): Record<string, string> {
  ipCounter += 1;
  return { 'x-forwarded-for': `203.0.113.${ipCounter}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSubscribeRateLimit();
});

describe('POST /api/newsletter/subscribe', () => {
  it('accepts a valid email and returns 200 { ok: true }', async () => {
    const res = await POST(post({ email: 'kai@example.com', source: 'footer' }, freshIp()));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(subscribeMock).toHaveBeenCalledWith('kai@example.com', 'footer');
  });

  it('defaults source to "unknown" when omitted', async () => {
    await POST(post({ email: 'kai@example.com' }, freshIp()));
    expect(subscribeMock).toHaveBeenCalledWith('kai@example.com', 'unknown');
  });

  it('returns 400 for an invalid email', async () => {
    const res = await POST(post({ email: 'not-an-email' }, freshIp()));
    expect(res.status).toBe(400);
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await POST(
      new Request('https://dorkos.ai/api/newsletter/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...freshIp() },
        body: '{ not json',
      })
    );
    expect(res.status).toBe(400);
  });

  it('still returns 200 when the service throws (no enumeration, no leak)', async () => {
    subscribeMock.mockRejectedValueOnce(new Error('db down'));
    const res = await POST(post({ email: 'kai@example.com' }, freshIp()));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});

describe('POST /api/newsletter/subscribe rate limiting', () => {
  it('lets one IP through up to the limit, then answers 429', async () => {
    const ip = freshIp();
    for (let i = 0; i < SUBSCRIBE_RATE_LIMIT; i += 1) {
      const ok = await POST(post({ email: `kai+${i}@example.com` }, ip));
      expect(ok.status).toBe(200);
    }
    expect(subscribeMock).toHaveBeenCalledTimes(SUBSCRIBE_RATE_LIMIT);

    const blocked = await POST(post({ email: 'kai+over@example.com' }, ip));
    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toEqual({
      error: 'Too many requests. Please wait a few minutes and try again.',
    });
    // The throttled request never reaches the mailing list.
    expect(subscribeMock).toHaveBeenCalledTimes(SUBSCRIBE_RATE_LIMIT);
  });

  it('sends a positive Retry-After on the 429', async () => {
    const ip = freshIp();
    for (let i = 0; i <= SUBSCRIBE_RATE_LIMIT; i += 1) await POST(post({ email: 'k@e.com' }, ip));

    const blocked = await POST(post({ email: 'k@e.com' }, ip));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it("does not charge one IP for another IP's attempts", async () => {
    const abuser = freshIp();
    for (let i = 0; i <= SUBSCRIBE_RATE_LIMIT; i += 1)
      await POST(post({ email: 'k@e.com' }, abuser));
    expect((await POST(post({ email: 'k@e.com' }, abuser))).status).toBe(429);

    const bystander = await POST(post({ email: 'priya@example.com' }, freshIp()));
    expect(bystander.status).toBe(200);
  });

  it('reads x-real-ip when x-forwarded-for is absent', async () => {
    const ip = { 'x-real-ip': '198.51.100.9' };
    for (let i = 0; i < SUBSCRIBE_RATE_LIMIT; i += 1) {
      expect((await POST(post({ email: 'k@e.com' }, ip))).status).toBe(200);
    }
    expect((await POST(post({ email: 'k@e.com' }, ip))).status).toBe(429);
  });

  it('meters header-less requests together in one shared bucket', async () => {
    for (let i = 0; i < SUBSCRIBE_RATE_LIMIT; i += 1) {
      expect((await POST(post({ email: 'k@e.com' }))).status).toBe(200);
    }
    expect((await POST(post({ email: 'k@e.com' }))).status).toBe(429);
  });

  it('charges rejected payloads too, so garbage floods still get throttled', async () => {
    const ip = freshIp();
    for (let i = 0; i < SUBSCRIBE_RATE_LIMIT; i += 1) {
      expect((await POST(post({ email: 'not-an-email' }, ip))).status).toBe(400);
    }
    expect((await POST(post({ email: 'kai@example.com' }, ip))).status).toBe(429);
    expect(subscribeMock).not.toHaveBeenCalled();
  });
});
