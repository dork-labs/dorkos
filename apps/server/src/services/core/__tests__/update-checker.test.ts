import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLatestVersion, resetCache } from '../update-checker.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('update-checker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-16T12:00:00Z'));
    resetCache();
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
});
