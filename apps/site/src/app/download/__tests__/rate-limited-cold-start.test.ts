import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetDesktopReleaseCache } from '@/lib/desktop-download';

import { GET as getMac } from '../mac/route';
import { GET as getWindows } from '../windows/route';

vi.mock('@/lib/telemetry/download-count', () => ({ countDownload: vi.fn() }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// DOR-4300: the GitHub limit is per IP and Vercel's outbound IPs are shared,
// so a fresh instance can be refused before it has ever fetched a list. The
// download button must land on the release page, never an error page.
describe('download links on a cold instance GitHub refuses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDesktopReleaseCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch.mockResolvedValue({ ok: false, status: 403 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['mac', getMac],
    ['windows', getWindows],
  ])('/download/%s 302-redirects to the latest release page', async (platform, get) => {
    const res = await get(new Request(`https://dorkos.ai/download/${platform}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://github.com/dork-labs/dorkos/releases/latest');
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
