import { APIError } from 'better-auth/api';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db/transaction-client', () => ({ getTransactionDb: vi.fn() }));

import { ERASURE_REFUSED_MESSAGE, refuseErasureWhileAppsSignedIn } from '../erasure';

describe('refuseErasureWhileAppsSignedIn', () => {
  it('lets the erasure go ahead once no sign-in is live at the service', async () => {
    const end = vi.fn(async () => 0);
    await expect(refuseErasureWhileAppsSignedIn('owner-a', end)).resolves.toBeUndefined();
    expect(end).toHaveBeenCalledWith('owner-a');
  });

  it('refuses with a plain reason while any sign-in is still live', async () => {
    const refusal = refuseErasureWhileAppsSignedIn('owner-a', async () => 2);
    await expect(refusal).rejects.toBeInstanceOf(APIError);
    await expect(refusal).rejects.toMatchObject({
      status: 'SERVICE_UNAVAILABLE',
      message: ERASURE_REFUSED_MESSAGE,
    });
  });
});
