import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findLatestExeDownloadUrl } from '@/lib/desktop-download';

import { countDownload } from '@/lib/telemetry/download-count';

import { GET } from '../route';

const request = () => new Request('https://dorkos.ai/download/windows');

vi.mock('@/lib/desktop-download', () => ({ findLatestExeDownloadUrl: vi.fn() }));
vi.mock('@/lib/telemetry/download-count', () => ({ countDownload: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /download/windows', () => {
  it('302-redirects to the resolved .exe url', async () => {
    vi.mocked(findLatestExeDownloadUrl).mockResolvedValue('https://example.com/DorkOS-0.1.0.exe');

    const res = await GET(request());

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/DorkOS-0.1.0.exe');
    expect(countDownload).toHaveBeenCalledWith(expect.any(Request), 'windows', true);
  });

  it('returns 503 with a plain-text body when no release is available', async () => {
    vi.mocked(findLatestExeDownloadUrl).mockResolvedValue(null);

    const res = await GET(request());

    expect(res.status).toBe(503);
    expect(countDownload).toHaveBeenCalledWith(expect.any(Request), 'windows', false);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });
});
