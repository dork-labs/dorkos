import { beforeEach, describe, expect, it, vi } from 'vitest';

const { unsubscribeMock } = vi.hoisted(() => ({
  unsubscribeMock: vi.fn().mockResolvedValue('unsubscribed'),
}));
vi.mock('@/lib/newsletter/service', () => ({ unsubscribe: unsubscribeMock }));

import { GET, POST } from '../route';

const url = 'https://dorkos.ai/api/newsletter/unsubscribe?token=tok';

beforeEach(() => vi.clearAllMocks());

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
