import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock version module — must be before importing update-checker
vi.mock('../../../lib/version.js', () => ({
  IS_DEV_BUILD: false,
  SERVER_VERSION: '1.0.0',
}));

import { getLatestVersion, resetCache } from '../update-checker.js';
import * as versionModule from '../../../lib/version.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('update-checker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-16T12:00:00Z'));
    resetCache();
    // Default to production mode
    vi.mocked(versionModule).IS_DEV_BUILD = false as never;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches and caches on first call', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.2.0' }),
    });

    const result = await getLatestVersion();
    expect(result).toBe('0.2.0');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns cached value within TTL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.2.0' }),
    });

    await getLatestVersion(); // First call — fetches
    const result = await getLatestVersion(); // Second call — cache hit
    expect(result).toBe('0.2.0');
    expect(mockFetch).toHaveBeenCalledTimes(1); // Only one fetch
  });

  it('re-fetches after TTL expires', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ version: '0.2.0' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ version: '0.3.0' }),
      });

    await getLatestVersion(); // First call
    vi.advanceTimersByTime(61 * 60 * 1000); // Advance past 1-hour TTL
    const result = await getLatestVersion(); // Should re-fetch
    expect(result).toBe('0.3.0');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns stale cache on fetch failure', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ version: '0.2.0' }),
      })
      .mockRejectedValueOnce(new Error('Network error'));

    await getLatestVersion(); // Populate cache
    vi.advanceTimersByTime(61 * 60 * 1000); // Expire TTL
    const result = await getLatestVersion(); // Fetch fails
    expect(result).toBe('0.2.0'); // Returns stale
  });

  it('returns null when never fetched and fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await getLatestVersion();
    expect(result).toBeNull();
  });

  it('returns stale cache on non-ok response', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ version: '0.2.0' }),
      })
      .mockResolvedValueOnce({ ok: false });

    await getLatestVersion();
    vi.advanceTimersByTime(61 * 60 * 1000);
    const result = await getLatestVersion();
    expect(result).toBe('0.2.0');
  });

  describe('dev mode guard', () => {
    it('returns null immediately when IS_DEV_BUILD is true', async () => {
      vi.mocked(versionModule).IS_DEV_BUILD = true as never;
      const result = await getLatestVersion();
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not update cache when in dev mode', async () => {
      // First, fetch in production mode to populate cache
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '0.2.0' }),
      });
      await getLatestVersion();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Switch to dev mode — should return null without touching cache
      vi.mocked(versionModule).IS_DEV_BUILD = true as never;
      const result = await getLatestVersion();
      expect(result).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1); // No additional fetch
    });

    it('fetches from npm registry when IS_DEV_BUILD is false', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '1.2.0' }),
      });
      const result = await getLatestVersion();
      expect(result).toBe('1.2.0');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
