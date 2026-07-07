import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/env';
import { getAuth } from '@/lib/auth';
import { runCleanup } from '@/lib/cleanup-service';

import { GET } from '../route';

// The route only needs a stand-in auth handle and a stubbed cleanup pass; the
// service's own behavior is covered by cleanup-service.integration.test.ts.
vi.mock('@/lib/auth', () => ({ getAuth: vi.fn(() => ({ marker: 'auth' })) }));
vi.mock('@/lib/cleanup-service', () => ({
  runCleanup: vi.fn().mockResolvedValue({
    unverifiedUsers: 2,
    expiredDeviceCodes: 3,
    staleInstances: 1,
  }),
}));

const SECRET = 'test-cron-secret';

/** Build a cron request with an optional Authorization header. */
function cronRequest(authorization?: string): Request {
  const headers: Record<string, string> = {};
  if (authorization) headers.authorization = authorization;
  return new Request('https://dorkos.ai/api/cron/cleanup', { method: 'GET', headers });
}

beforeEach(() => {
  env.CRON_SECRET = SECRET;
});
afterEach(() => {
  env.CRON_SECRET = undefined;
  vi.clearAllMocks();
});

describe('GET /api/cron/cleanup', () => {
  it('401s when no Authorization header is present', async () => {
    const res = await GET(cronRequest());
    expect(res.status).toBe(401);
    expect(runCleanup).not.toHaveBeenCalled();
  });

  it('401s when the Bearer secret does not match', async () => {
    const res = await GET(cronRequest('Bearer wrong-secret'));
    expect(res.status).toBe(401);
    expect(runCleanup).not.toHaveBeenCalled();
  });

  it('401s (fail closed) when CRON_SECRET is unset, even with a Bearer token', async () => {
    env.CRON_SECRET = undefined;
    const res = await GET(cronRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(401);
    expect(runCleanup).not.toHaveBeenCalled();
  });

  it('runs the cleanup and returns counts when the Bearer secret matches', async () => {
    const res = await GET(cronRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; counts: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(body.counts).toEqual({ unverifiedUsers: 2, expiredDeviceCodes: 3, staleInstances: 1 });
    expect(runCleanup).toHaveBeenCalledTimes(1);
    expect(runCleanup).toHaveBeenCalledWith(getAuth(), {});
  });
});
