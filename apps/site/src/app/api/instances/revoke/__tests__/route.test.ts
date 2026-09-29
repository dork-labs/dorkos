import { afterEach, describe, expect, it, vi } from 'vitest';

import { getServerSession } from '@/lib/auth-session';
import { endRevokedInstanceConnections } from '@/lib/connectors/managed/instance-revocation/cleanup';
import { revokeInstance } from '@/lib/instance-service';

import { POST } from '../route';

vi.mock('@/lib/auth', () => ({ getAuth: vi.fn(() => ({ marker: 'auth' })) }));
vi.mock('@/lib/auth-session', () => ({ getServerSession: vi.fn() }));
vi.mock('@/db/transaction-client', () => ({ getTransactionDb: vi.fn(() => ({ marker: 'db' })) }));
vi.mock('@/lib/instance-service', () => ({ revokeInstance: vi.fn() }));
vi.mock('@/lib/connectors/managed/instance-revocation/cleanup', () => ({
  endRevokedInstanceConnections: vi.fn(),
}));

function revokeRequest(body: unknown): Request {
  return new Request('https://dorkos.ai/api/instances/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function signedIn(): void {
  vi.mocked(getServerSession).mockResolvedValue({ user: { id: 'owner-a' } } as never);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/instances/revoke', () => {
  it('ends the revoked machine’s app sign-ins right after the revoke', async () => {
    signedIn();
    vi.mocked(revokeInstance).mockResolvedValue({ ok: true });

    const response = await POST(revokeRequest({ instanceId: 'instance-a' }));

    expect(response.status).toBe(200);
    expect(revokeInstance).toHaveBeenCalledWith(
      { marker: 'auth' },
      { userId: 'owner-a', instanceId: 'instance-a' }
    );
    expect(endRevokedInstanceConnections).toHaveBeenCalledWith({ marker: 'db' }, 'instance-a', {
      signal: expect.any(AbortSignal),
    });
    expect(vi.mocked(revokeInstance).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(endRevokedInstanceConnections).mock.invocationCallOrder[0]
    );
  });

  it('still reports the revoke when ending the sign-ins fails, and says nothing about why', async () => {
    signedIn();
    vi.mocked(revokeInstance).mockResolvedValue({ ok: true });
    vi.mocked(endRevokedInstanceConnections).mockRejectedValue(new Error('private sql detail'));

    const response = await POST(revokeRequest({ instanceId: 'instance-a' }));

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('private sql detail');
  });

  it('touches no connection when the machine is not the caller’s', async () => {
    signedIn();
    vi.mocked(revokeInstance).mockResolvedValue({ ok: false, notFound: true });

    const response = await POST(revokeRequest({ instanceId: 'someone-elses' }));

    expect(response.status).toBe(404);
    expect(endRevokedInstanceConnections).not.toHaveBeenCalled();
  });

  it('refuses a caller who is not signed in', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    const response = await POST(revokeRequest({ instanceId: 'instance-a' }));

    expect(response.status).toBe(401);
    expect(revokeInstance).not.toHaveBeenCalled();
    expect(endRevokedInstanceConnections).not.toHaveBeenCalled();
  });
});
