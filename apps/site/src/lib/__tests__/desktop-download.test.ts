import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findLatestDmgDownloadUrl, findLatestExeDownloadUrl } from '../desktop-download';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

/** Build a minimal GitHub release list API response. */
function releasesResponse(releases: unknown[]): { ok: true; json: () => Promise<unknown> } {
  return { ok: true, json: () => Promise.resolve(releases) };
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.clearAllMocks();
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
