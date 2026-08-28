import { beforeEach, describe, expect, it, vi } from 'vitest';

const { unsubscribeMock } = vi.hoisted(() => ({
  unsubscribeMock: vi.fn().mockResolvedValue('unsubscribed'),
}));
vi.mock('@/lib/newsletter/service', () => ({ unsubscribe: unsubscribeMock }));

import {
  UNSUBSCRIBE_LINK_RATE_LIMIT,
  UNSUBSCRIBE_ONE_CLICK_RATE_LIMIT,
  resetUnsubscribeRateLimit,
} from '@/lib/newsletter/unsubscribe-rate-limit';

import { GET, POST } from '../route';

const url = 'https://dorkos.ai/api/newsletter/unsubscribe?token=tok';

beforeEach(() => {
  vi.clearAllMocks();
  resetUnsubscribeRateLimit();
});

describe('/api/newsletter/unsubscribe', () => {
  it('GET (human-clicked link) redirects to the result page', async () => {
    const res = await GET(new Request(url));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/newsletter/unsubscribed');
    expect(unsubscribeMock).toHaveBeenCalledWith('tok');
  });

  it('POST (RFC 8058 one-click) returns a bare 200, not a redirect', async () => {
    const res = await POST(new Request(url, { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(unsubscribeMock).toHaveBeenCalledWith('tok');
  });
});

describe('/api/newsletter/unsubscribe rate limiting', () => {
  const ip = { 'x-real-ip': '203.0.113.30' };
  const getReq = (headers: Record<string, string>): Request => new Request(url, { headers });
  const postReq = (headers: Record<string, string>): Request =>
    new Request(url, { method: 'POST', headers });

  it('lets one IP open the link up to the limit, then answers 429', async () => {
    for (let i = 0; i < UNSUBSCRIBE_LINK_RATE_LIMIT; i += 1) {
      expect((await GET(getReq(ip))).status).toBe(303);
    }
    expect(unsubscribeMock).toHaveBeenCalledTimes(UNSUBSCRIBE_LINK_RATE_LIMIT);

    const blocked = await GET(getReq(ip));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('600');
    // The throttled request never reaches the token lookup.
    expect(unsubscribeMock).toHaveBeenCalledTimes(UNSUBSCRIBE_LINK_RATE_LIMIT);
  });

  it('answers a throttled GET as a page a person can read', async () => {
    for (let i = 0; i < UNSUBSCRIBE_LINK_RATE_LIMIT; i += 1) await GET(getReq(ip));

    const blocked = await GET(getReq(ip));
    expect(blocked.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const body = await blocked.text();
    expect(body).toContain('<!doctype html>');
    // De-personalised: it names the network, never accuses the reader.
    expect(body).toContain('Too many people opened this link from your network');
    expect(body).toContain('Try again in about 10 minutes to unsubscribe.');
  });

  it('answers a throttled one-click POST bare, the way the mail client expects', async () => {
    for (let i = 0; i < UNSUBSCRIBE_ONE_CLICK_RATE_LIMIT; i += 1) await POST(postReq(ip));

    const blocked = await POST(postReq(ip));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('600');
    expect(blocked.headers.get('location')).toBeNull();
    // No HTML for a caller that never renders one.
    await expect(blocked.text()).resolves.toBe('');
  });

  it('never lets a scanner sweep of the link starve a real one-click unsubscribe', async () => {
    // The link is in every broadcast, so one corporate gateway pre-fetching it
    // can exhaust the GET allowance through no reader's fault. A one-click POST
    // arriving right after must still unsubscribe the person who asked —
    // refusing it would leave them subscribed while telling them they are not.
    for (let i = 0; i <= UNSUBSCRIBE_LINK_RATE_LIMIT; i += 1) await GET(getReq(ip));
    expect((await GET(getReq(ip))).status).toBe(429);

    const oneClick = await POST(postReq(ip));
    expect(oneClick.status).toBe(200);
    expect(unsubscribeMock).toHaveBeenLastCalledWith('tok');
  });

  it('does not let a one-click flood starve the in-email link either', async () => {
    for (let i = 0; i <= UNSUBSCRIBE_ONE_CLICK_RATE_LIMIT; i += 1) await POST(postReq(ip));
    expect((await POST(postReq(ip))).status).toBe(429);

    expect((await GET(getReq(ip))).status).toBe(303);
  });

  it("does not charge one IP for another IP's attempts", async () => {
    for (let i = 0; i <= UNSUBSCRIBE_LINK_RATE_LIMIT; i += 1) await GET(getReq(ip));
    expect((await GET(getReq(ip))).status).toBe(429);

    expect((await GET(getReq({ 'x-real-ip': '203.0.113.31' }))).status).toBe(303);
  });
});
