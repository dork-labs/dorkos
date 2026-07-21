import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchRegistryUpdatedAt } from '@/layers/features/marketplace/lib/updated-at';

import { GET } from '../route';

vi.mock('@/layers/features/marketplace/lib/updated-at', () => ({
  fetchRegistryUpdatedAt: vi.fn(),
}));

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  vi.clearAllMocks();
});

describe('GET /api/telemetry/updated-at', () => {
  it('returns the registry recency map with a cacheable Cache-Control header', async () => {
    vi.mocked(fetchRegistryUpdatedAt).mockResolvedValue({
      'code-reviewer': '2026-07-18T17:41:20Z',
      flow: '2026-07-10T09:00:00Z',
    });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      updatedAt: { 'code-reviewer': '2026-07-18T17:41:20Z', flow: '2026-07-10T09:00:00Z' },
    });
    expect(res.headers.get('Cache-Control')).toBe(
      'public, s-maxage=3600, stale-while-revalidate=86400'
    );
  });

  it('returns an empty map when no package carries a registry-derived date', async () => {
    vi.mocked(fetchRegistryUpdatedAt).mockResolvedValue({});

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updatedAt: {} });
  });

  it('degrades to an empty, uncacheable map when the registry read fails', async () => {
    vi.mocked(fetchRegistryUpdatedAt).mockRejectedValue(new Error('github down'));

    const res = await GET();

    // Never surfaces backend health: 200 with an empty map...
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updatedAt: {} });
    // ...and a no-store header so the transient failure is not cached for an hour.
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
