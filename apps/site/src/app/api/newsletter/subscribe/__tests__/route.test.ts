import { beforeEach, describe, expect, it, vi } from 'vitest';

const { subscribeMock } = vi.hoisted(() => ({
  subscribeMock: vi.fn().mockResolvedValue('created'),
}));
vi.mock('@/lib/newsletter/service', () => ({ subscribe: subscribeMock }));

import { POST } from '../route';

function post(body: unknown): Request {
  return new Request('https://dorkos.ai/api/newsletter/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => vi.clearAllMocks());

describe('POST /api/newsletter/subscribe', () => {
  it('accepts a valid email and returns 200 { ok: true }', async () => {
    const res = await POST(post({ email: 'kai@example.com', source: 'footer' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(subscribeMock).toHaveBeenCalledWith('kai@example.com', 'footer');
  });

  it('defaults source to "unknown" when omitted', async () => {
    await POST(post({ email: 'kai@example.com' }));
    expect(subscribeMock).toHaveBeenCalledWith('kai@example.com', 'unknown');
  });

  it('returns 400 for an invalid email', async () => {
    const res = await POST(post({ email: 'not-an-email' }));
    expect(res.status).toBe(400);
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await POST(
      new Request('https://dorkos.ai/api/newsletter/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      })
    );
    expect(res.status).toBe(400);
  });

  it('still returns 200 when the service throws (no enumeration, no leak)', async () => {
    subscribeMock.mockRejectedValueOnce(new Error('db down'));
    const res = await POST(post({ email: 'kai@example.com' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});
