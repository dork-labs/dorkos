import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/env';
import { recoverManagedEventCleanup } from '@/lib/connectors/managed/event-cleanup-service';
import { sweepManagedConnectorEventRetention } from '@/lib/connectors/managed/event-delivery-service';

import { GET } from '../route';

vi.mock('@/db/transaction-client', () => ({ getTransactionDb: vi.fn(() => ({ marker: 'db' })) }));
vi.mock('@/lib/connectors/managed/event-cleanup-service', () => ({
  recoverManagedEventCleanup: vi.fn().mockResolvedValue({ examined: 1, completed: 1 }),
}));
vi.mock('@/lib/connectors/managed/event-delivery-service', () => ({
  sweepManagedConnectorEventRetention: vi.fn().mockResolvedValue({
    pages: 1,
    contentRowsCleared: 2,
    metadataRowsDeleted: 1,
    protectedBytesCleared: 256,
  }),
}));
// Proves the split: this route never reaches the account cleanup pass. The mock
// throws rather than returning, so a stray call fails loudly instead of quietly
// succeeding.
vi.mock('@/lib/cleanup-service', () => ({
  runCleanup: vi.fn(() => {
    throw new Error('instance expiry belongs to /api/cron/instance-expiry');
  }),
}));

const SECRET = 'test-cron-secret';

/** Build a cron request with an optional Authorization header. */
function cronRequest(authorization?: string): Request {
  const headers: Record<string, string> = {};
  if (authorization) headers.authorization = authorization;
  return new Request('https://dorkos.ai/api/cron/event-retention', { method: 'GET', headers });
}

beforeEach(() => {
  env.CRON_SECRET = SECRET;
});
afterEach(() => {
  env.CRON_SECRET = undefined;
  vi.clearAllMocks();
});

describe('GET /api/cron/event-retention', () => {
  it('401s when no Authorization header is present', async () => {
    const res = await GET(cronRequest());
    expect(res.status).toBe(401);
    expect(sweepManagedConnectorEventRetention).not.toHaveBeenCalled();
    expect(recoverManagedEventCleanup).not.toHaveBeenCalled();
  });

  it('401s when the Bearer secret does not match', async () => {
    const res = await GET(cronRequest('Bearer wrong-secret'));
    expect(res.status).toBe(401);
    expect(sweepManagedConnectorEventRetention).not.toHaveBeenCalled();
  });

  it('401s (fail closed) when CRON_SECRET is unset, even with a Bearer token', async () => {
    env.CRON_SECRET = undefined;
    const res = await GET(cronRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(401);
    expect(sweepManagedConnectorEventRetention).not.toHaveBeenCalled();
    expect(recoverManagedEventCleanup).not.toHaveBeenCalled();
  });

  it('sweeps retention and recovers cleanups when the Bearer secret matches', async () => {
    const res = await GET(cronRequest(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      eventRetention: Record<string, number>;
      eventSubscriptions: Record<string, number>;
    };
    expect(body.ok).toBe(true);
    expect(body.eventRetention).toEqual({
      pages: 1,
      contentRowsCleared: 2,
      metadataRowsDeleted: 1,
      protectedBytesCleared: 256,
    });
    expect(body.eventSubscriptions).toEqual({ examined: 1, completed: 1 });
    expect(sweepManagedConnectorEventRetention).toHaveBeenCalledWith(
      { marker: 'db' },
      { signal: expect.any(AbortSignal) }
    );
    expect(recoverManagedEventCleanup).toHaveBeenCalledWith(
      { marker: 'db' },
      expect.any(AbortSignal)
    );
  });

  it('reports payload-free maintenance failure after authentication', async () => {
    vi.mocked(sweepManagedConnectorEventRetention).mockRejectedValueOnce(
      new Error('private provider data')
    );
    const response = await GET(cronRequest(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private provider data');
  });
});
