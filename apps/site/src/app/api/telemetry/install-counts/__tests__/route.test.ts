import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchInstallCounts } from '@/layers/features/marketplace/lib/telemetry';

import { GET } from '../route';

vi.mock('@/layers/features/marketplace/lib/telemetry', () => ({
  fetchInstallCounts: vi.fn(),
}));

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  vi.clearAllMocks();
});

describe('GET /api/telemetry/install-counts', () => {
  it('returns the aggregate counts map with a cacheable Cache-Control header', async () => {
    vi.mocked(fetchInstallCounts).mockResolvedValue({ 'code-reviewer': 42, flow: 7 });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ counts: { 'code-reviewer': 42, flow: 7 } });
    expect(res.headers.get('Cache-Control')).toBe(
      'public, s-maxage=3600, stale-while-revalidate=86400'
    );
  });

  it('returns an empty map when no package has any successful installs', async () => {
    vi.mocked(fetchInstallCounts).mockResolvedValue({});

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ counts: {} });
  });

  it('degrades to an empty, uncacheable map when the database read fails', async () => {
    vi.mocked(fetchInstallCounts).mockRejectedValue(new Error('neon down'));

    const res = await GET();

    // Never surfaces backend health: 200 with an empty map...
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ counts: {} });
    // ...and a no-store header so the transient failure is not cached for an hour.
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
