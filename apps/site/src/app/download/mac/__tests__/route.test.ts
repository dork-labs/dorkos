import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findLatestDmgDownloadUrl } from '@/lib/desktop-download';

import { GET } from '../route';

vi.mock('@/lib/desktop-download', () => ({ findLatestDmgDownloadUrl: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /download/mac', () => {
  it('302-redirects to the resolved .dmg url', async () => {
    vi.mocked(findLatestDmgDownloadUrl).mockResolvedValue('https://example.com/DorkOS-0.1.0.dmg');

    const res = await GET();

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/DorkOS-0.1.0.dmg');
  });

  it('returns 503 with a plain-text body when no release is available', async () => {
    vi.mocked(findLatestDmgDownloadUrl).mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });
});
