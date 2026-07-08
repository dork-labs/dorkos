import { beforeEach, describe, expect, it, vi } from 'vitest';

const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));
vi.mock('@/lib/newsletter/service', () => ({ confirm: confirmMock }));

import { GET } from '../route';

function get(token: string): Request {
  return new Request(`https://dorkos.ai/api/newsletter/confirm?token=${token}`);
}

beforeEach(() => vi.clearAllMocks());

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
