import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RELEASE_LIST_TTL_MS,
  findLatestDmgDownloadUrl,
  findLatestExeDownloadUrl,
  resetDesktopReleaseCache,
} from '../desktop-download';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** Build a minimal GitHub release list API response. */
function releasesResponse(releases: unknown[]): { ok: true; json: () => Promise<unknown> } {
  return { ok: true, json: () => Promise.resolve(releases) };
}

/** One published release shipping a mac and a Windows build at `version`. */
function desktopRelease(version: string, publishedAt: string): unknown {
  return {
    draft: false,
    prerelease: false,
    published_at: publishedAt,
    created_at: publishedAt,
    assets: [
      {
        name: `DorkOS-${version}-arm64.dmg`,
        browser_download_url: `https://example.com/${version}.dmg`,
      },
      {
        name: `DorkOS-${version}-x64.exe`,
        browser_download_url: `https://example.com/${version}.exe`,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDesktopReleaseCache();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

// DOR-4300: with a 5-minute stale-while-revalidate data cache, the first visit
// after a quiet spell got the release list from before the newest release.
describe('release list freshness', () => {
  it('asks GitHub directly, never through the Next.js data cache', async () => {
    mockFetch.mockResolvedValue(releasesResponse([]));

    await findLatestDmgDownloadUrl();

    const init = mockFetch.mock.calls[0]?.[1] as RequestInit & { next?: unknown };
    expect(init.cache).toBe('no-store');
    expect(init.next).toBeUndefined();
  });

  it('serves a new release on the first visit once the short window passes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));
    mockFetch.mockResolvedValueOnce(
      releasesResponse([desktopRelease('0.1.0', '2026-06-01T00:00:00Z')])
    );
    expect(await findLatestDmgDownloadUrl()).toBe('https://example.com/0.1.0.dmg');

    vi.setSystemTime(Date.now() + RELEASE_LIST_TTL_MS + 1);
    mockFetch.mockResolvedValueOnce(
      releasesResponse([
        desktopRelease('0.2.0', '2026-07-01T00:00:00Z'),
        desktopRelease('0.1.0', '2026-06-01T00:00:00Z'),
      ])
    );

    expect(await findLatestDmgDownloadUrl()).toBe('https://example.com/0.2.0.dmg');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the window short: at most one minute', () => {
    expect(RELEASE_LIST_TTL_MS).toBeLessThanOrEqual(60_000);
  });

  it('shares one GitHub call between both links inside the window', async () => {
    mockFetch.mockResolvedValue(
      releasesResponse([desktopRelease('0.1.0', '2026-06-01T00:00:00Z')])
    );

    expect(await findLatestDmgDownloadUrl()).toBe('https://example.com/0.1.0.dmg');
    expect(await findLatestExeDownloadUrl()).toBe('https://example.com/0.1.0.exe');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to the last good list when GitHub refuses (rate limit)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));
    mockFetch.mockResolvedValueOnce(
      releasesResponse([desktopRelease('0.1.0', '2026-06-01T00:00:00Z')])
    );
    await findLatestDmgDownloadUrl();

    vi.setSystemTime(Date.now() + RELEASE_LIST_TTL_MS + 1);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    expect(await findLatestDmgDownloadUrl()).toBe('https://example.com/0.1.0.dmg');
  });
});

describe('findLatestDmgDownloadUrl', () => {
  it('returns null when the release list is empty', async () => {
    mockFetch.mockResolvedValue(releasesResponse([]));
    expect(await findLatestDmgDownloadUrl()).toBeNull();
  });

  it('returns null when no release has a .dmg asset', async () => {
    mockFetch.mockResolvedValue(
      releasesResponse([
        {
          draft: false,
          prerelease: false,
          published_at: '2026-07-01T00:00:00Z',
          created_at: '2026-07-01T00:00:00Z',
          assets: [{ name: 'dorkos-0.45.1.tgz', browser_download_url: 'https://example.com/tgz' }],
        },
      ])
    );
    expect(await findLatestDmgDownloadUrl()).toBeNull();
  });

  it('returns the .dmg asset url when a release has one', async () => {
    mockFetch.mockResolvedValue(
      releasesResponse([
        {
          draft: false,
          prerelease: false,
          published_at: '2026-07-01T00:00:00Z',
          created_at: '2026-07-01T00:00:00Z',
          assets: [
            {
              name: 'DorkOS-0.1.0-arm64.dmg',
              browser_download_url: 'https://example.com/DorkOS-0.1.0-arm64.dmg',
            },
          ],
        },
      ])
    );
    expect(await findLatestDmgDownloadUrl()).toBe('https://example.com/DorkOS-0.1.0-arm64.dmg');
  });

  it('picks the newest .dmg release, not the first in the list', async () => {
    mockFetch.mockResolvedValue(
      releasesResponse([
        {
          draft: false,
          prerelease: false,
          published_at: '2026-06-01T00:00:00Z',
          created_at: '2026-06-01T00:00:00Z',
          assets: [
            { name: 'DorkOS-0.1.0-arm64.dmg', browser_download_url: 'https://example.com/old.dmg' },
          ],
        },
        {
          draft: false,
          prerelease: true,
          published_at: '2026-07-05T00:00:00Z',
          created_at: '2026-07-05T00:00:00Z',
          assets: [
            { name: 'DorkOS-0.2.0-arm64.dmg', browser_download_url: 'https://example.com/new.dmg' },
          ],
        },
      ])
    );
    expect(await findLatestDmgDownloadUrl()).toBe('https://example.com/new.dmg');
  });

  it('includes prerelease releases', async () => {
    mockFetch.mockResolvedValue(
      releasesResponse([
        {
          draft: false,
          prerelease: true,
          published_at: '2026-07-01T00:00:00Z',
          created_at: '2026-07-01T00:00:00Z',
          assets: [
            { name: 'DorkOS-0.1.0-arm64.dmg', browser_download_url: 'https://example.com/pre.dmg' },
          ],
        },
      ])
    );
    expect(await findLatestDmgDownloadUrl()).toBe('https://example.com/pre.dmg');
  });

  it('excludes draft releases even if present in the response', async () => {
    mockFetch.mockResolvedValue(
      releasesResponse([
        {
          draft: true,
          prerelease: false,
          published_at: '2026-07-05T00:00:00Z',
          created_at: '2026-07-05T00:00:00Z',
          assets: [
            {
              name: 'DorkOS-0.2.0-arm64.dmg',
              browser_download_url: 'https://example.com/draft.dmg',
            },
          ],
        },
        {
          draft: false,
          prerelease: false,
          published_at: '2026-06-01T00:00:00Z',
          created_at: '2026-06-01T00:00:00Z',
          assets: [
            {
              name: 'DorkOS-0.1.0-arm64.dmg',
              browser_download_url: 'https://example.com/published.dmg',
            },
          ],
        },
      ])
    );
    expect(await findLatestDmgDownloadUrl()).toBe('https://example.com/published.dmg');
  });

  it('returns null when the GitHub API responds non-ok', async () => {
    mockFetch.mockResolvedValue({ ok: false });
    expect(await findLatestDmgDownloadUrl()).toBeNull();
  });

  it('returns null when the fetch call throws', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    expect(await findLatestDmgDownloadUrl()).toBeNull();
  });

  it('returns null when the response body is not valid JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error('invalid json')),
    });
    expect(await findLatestDmgDownloadUrl()).toBeNull();
  });

  it('ignores a release that only ships a non-dmg (e.g. .exe) asset', async () => {
    mockFetch.mockResolvedValue(
      releasesResponse([
        {
          draft: false,
          prerelease: false,
          published_at: '2026-07-01T00:00:00Z',
          created_at: '2026-07-01T00:00:00Z',
          assets: [
            {
              name: 'DorkOS-0.2.0-x64.exe',
              browser_download_url: 'https://example.com/win.exe',
            },
          ],
        },
      ])
    );
    expect(await findLatestDmgDownloadUrl()).toBeNull();
  });
});

describe('findLatestExeDownloadUrl', () => {
  it('returns null when no release has a .exe asset', async () => {
    mockFetch.mockResolvedValue(
      releasesResponse([
        {
          draft: false,
          prerelease: false,
          published_at: '2026-07-01T00:00:00Z',
          created_at: '2026-07-01T00:00:00Z',
          assets: [
            {
              name: 'DorkOS-0.1.0-arm64.dmg',
              browser_download_url: 'https://example.com/mac.dmg',
            },
          ],
        },
      ])
    );
    expect(await findLatestExeDownloadUrl()).toBeNull();
  });

  it('returns the .exe asset url when a release has one', async () => {
    mockFetch.mockResolvedValue(
      releasesResponse([
        {
          draft: false,
          prerelease: false,
          published_at: '2026-07-01T00:00:00Z',
          created_at: '2026-07-01T00:00:00Z',
          assets: [
            {
              name: 'DorkOS-0.2.0-x64.exe',
              browser_download_url: 'https://example.com/DorkOS-0.2.0-x64.exe',
            },
          ],
        },
      ])
    );
    expect(await findLatestExeDownloadUrl()).toBe('https://example.com/DorkOS-0.2.0-x64.exe');
  });

  it('picks the newest .exe release (prereleases included), not the first in the list', async () => {
    mockFetch.mockResolvedValue(
      releasesResponse([
        {
          draft: false,
          prerelease: false,
          published_at: '2026-06-01T00:00:00Z',
          created_at: '2026-06-01T00:00:00Z',
          assets: [
            { name: 'DorkOS-0.1.0-x64.exe', browser_download_url: 'https://example.com/old.exe' },
          ],
        },
        {
          draft: false,
          prerelease: true,
          published_at: '2026-07-05T00:00:00Z',
          created_at: '2026-07-05T00:00:00Z',
          assets: [
            { name: 'DorkOS-0.2.0-x64.exe', browser_download_url: 'https://example.com/new.exe' },
          ],
        },
      ])
    );
    expect(await findLatestExeDownloadUrl()).toBe('https://example.com/new.exe');
  });

  it('excludes draft releases even if present in the response', async () => {
    mockFetch.mockResolvedValue(
      releasesResponse([
        {
          draft: true,
          prerelease: false,
          published_at: '2026-07-05T00:00:00Z',
          created_at: '2026-07-05T00:00:00Z',
          assets: [
            { name: 'DorkOS-0.2.0-x64.exe', browser_download_url: 'https://example.com/draft.exe' },
          ],
        },
        {
          draft: false,
          prerelease: false,
          published_at: '2026-06-01T00:00:00Z',
          created_at: '2026-06-01T00:00:00Z',
          assets: [
            {
              name: 'DorkOS-0.1.0-x64.exe',
              browser_download_url: 'https://example.com/published.exe',
            },
          ],
        },
      ])
    );
    expect(await findLatestExeDownloadUrl()).toBe('https://example.com/published.exe');
  });

  it('returns null when the fetch call throws', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    expect(await findLatestExeDownloadUrl()).toBeNull();
  });
});
