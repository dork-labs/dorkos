import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findLatestDmgDownloadUrl } from '@/lib/desktop-download';

import { countDownload } from '@/lib/telemetry/download-count';

import * as route from '../route';
import { GET } from '../route';

const request = () => new Request('https://dorkos.ai/download/mac');

vi.mock('@/lib/desktop-download', () => ({ findLatestDmgDownloadUrl: vi.fn() }));
vi.mock('@/lib/telemetry/download-count', () => ({ countDownload: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /download/mac', () => {
  // DOR-4300: a cached route or a stale-while-revalidate data cache served the
  // old version for hours after a release. The route must run on every visit.
  it('runs on every request, with no route-level cache', () => {
    expect(route.dynamic).toBe('force-dynamic');
    expect('revalidate' in route).toBe(false);
  });

  it('302-redirects to the resolved .dmg url, uncacheable', async () => {
    vi.mocked(findLatestDmgDownloadUrl).mockResolvedValue('https://example.com/DorkOS-0.1.0.dmg');

    const res = await GET(request());

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/DorkOS-0.1.0.dmg');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(countDownload).toHaveBeenCalledWith(expect.any(Request), 'mac', true);
  });

  it('returns 503 with a plain-text body when no release is available', async () => {
    vi.mocked(findLatestDmgDownloadUrl).mockResolvedValue(null);

    const res = await GET(request());

    expect(res.status).toBe(503);
    expect(countDownload).toHaveBeenCalledWith(expect.any(Request), 'mac', false);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });
});
