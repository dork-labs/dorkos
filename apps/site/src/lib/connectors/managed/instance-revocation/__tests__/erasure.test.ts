import { APIError } from 'better-auth/api';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db/transaction-client', () => ({ getTransactionDb: vi.fn() }));

import {
  ERASURE_POSTPONED_LOCATION,
  ERASURE_STUCK_CLEANUP_MS,
  prepareAccountErasure,
  type AccountErasureDeps,
  type OwedProviderAccount,
} from '../erasure';

const NOW = new Date('2026-09-28T12:00:00.000Z');

function owedFor(ageMs: number, ref = 'ca_private'): OwedProviderAccount {
  return {
    providerInstanceId: 'managed:composio',
    providerUserId: 'provider-user',
    externalAccountRef: ref,
    owedSince: new Date(NOW.getTime() - ageMs),
  };
}

type LogError = AccountErasureDeps['logError'];

function deps(owed: OwedProviderAccount[] | Error): AccountErasureDeps & {
  logError: ReturnType<typeof vi.fn<LogError>>;
} {
  return {
    end: vi.fn(async () => {
      if (owed instanceof Error) throw owed;
      return owed;
    }),
    clock: () => NOW,
    logError: vi.fn<LogError>(),
  };
}

async function postponedLocation(promise: Promise<void>): Promise<string | null> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(APIError);
  expect((error as APIError).status).toBe('FOUND');
  return new Headers((error as APIError).headers).get('location');
}

describe('prepareAccountErasure', () => {
  it('goes ahead quietly once nothing is owed at the service', async () => {
    const seams = deps([]);
    await expect(prepareAccountErasure('owner-a', 'owner', seams)).resolves.toBeUndefined();
    expect(seams.end).toHaveBeenCalledWith('owner-a');
    expect(seams.logError).not.toHaveBeenCalled();
  });

  it('postpones the person’s own deletion back to the account page while the cleanup is young', async () => {
    const seams = deps([owedFor(ERASURE_STUCK_CLEANUP_MS - 60_000)]);
    expect(await postponedLocation(prepareAccountErasure('owner-a', 'owner', seams))).toBe(
      ERASURE_POSTPONED_LOCATION
    );
    expect(ERASURE_POSTPONED_LOCATION).toBe('/account?deletion=postponed');
    expect(seams.logError).not.toHaveBeenCalled();
  });

  it('postpones when the cleanup could not even run', async () => {
    const seams = deps(new Error('database unavailable'));
    expect(await postponedLocation(prepareAccountErasure('owner-a', 'owner', seams))).toBe(
      ERASURE_POSTPONED_LOCATION
    );
  });

  it('never waits forever: a deletion stuck past the bound goes ahead, with a log to finish by hand', async () => {
    const seams = deps([owedFor(ERASURE_STUCK_CLEANUP_MS + 1, 'ca_stuck')]);
    await expect(prepareAccountErasure('owner-a', 'owner', seams)).resolves.toBeUndefined();
    expect(seams.logError).toHaveBeenCalledTimes(1);
    const [message, details] = seams.logError.mock.calls[0];
    expect(message).toContain('delete them by hand');
    expect(details).toEqual({
      actor: 'owner',
      accounts: [
        {
          providerInstanceId: 'managed:composio',
          providerUserId: 'provider-user',
          externalAccountRef: 'ca_stuck',
          owedSince: new Date(NOW.getTime() - ERASURE_STUCK_CLEANUP_MS - 1).toISOString(),
        },
      ],
    });
    // Only provider ids: never the account being erased.
    expect(JSON.stringify(details)).not.toContain('owner-a');
  });

  it('still waits while any one owed deletion is young', async () => {
    const seams = deps([owedFor(ERASURE_STUCK_CLEANUP_MS + 1), owedFor(60_000, 'ca_fresh')]);
    expect(await postponedLocation(prepareAccountErasure('owner-a', 'owner', seams))).toBe(
      ERASURE_POSTPONED_LOCATION
    );
  });

  it('always lets an admin removal go ahead, logging what is still owed', async () => {
    const seams = deps([owedFor(60_000, 'ca_fresh')]);
    await expect(prepareAccountErasure('owner-a', 'admin', seams)).resolves.toBeUndefined();
    expect(seams.logError.mock.calls[0][1]).toMatchObject({
      actor: 'admin',
      accounts: [{ externalAccountRef: 'ca_fresh' }],
    });
  });

  it('lets an admin removal go ahead even when the cleanup could not run', async () => {
    const seams = deps(new Error('database unavailable'));
    await expect(prepareAccountErasure('owner-a', 'admin', seams)).resolves.toBeUndefined();
    expect(seams.logError.mock.calls[0][1]).toEqual({
      actor: 'admin',
      reason: 'cleanup_unavailable',
    });
  });
});
