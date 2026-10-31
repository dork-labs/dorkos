/**
 * The owner-password step-up (DOR-2946): checked by Better Auth's own hashing,
 * throttled globally by a growing delay, and refusing rather than opening on
 * anything odd.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { logger } from '../../../../lib/logger.js';
import {
  OWNER_PASSWORD_FAILURE_WINDOW_MS,
  OWNER_PASSWORD_MAX_DELAY_MS,
  checkOwnerPassword,
  ownerPasswordDelayMs,
  ownerPasswordRetryAfterMs,
  resetOwnerPasswordFailuresForTests,
  type OwnerPasswordDeps,
} from '../owner-password.js';
import { hashOwnerPassword, verifyOwnerPassword } from '../passwords/password-hash.js';

let hash: string;
let now: number;

function deps(overrides: Partial<OwnerPasswordDeps> = {}): OwnerPasswordDeps {
  return {
    ownerId: () => 'user_owner',
    verifier: async () => ({
      storedHash: async (userId) => (userId === 'user_owner' ? hash : null),
      verify: verifyPassword,
      maxLength: 128,
    }),
    now: () => now,
    ...overrides,
  };
}

beforeEach(async () => {
  resetOwnerPasswordFailuresForTests();
  now = 1_000_000;
  hash ??= await hashPassword('correct horse');
});
afterEach(() => resetOwnerPasswordFailuresForTests());

describe('checkOwnerPassword', () => {
  it('accepts the owner’s password, hashed the way Better Auth stores it', async () => {
    expect(await checkOwnerPassword('correct horse', deps())).toBe('ok');
  });

  it('refuses a wrong one, and asks for a missing one', async () => {
    expect(await checkOwnerPassword('wrong horse', deps())).toBe('wrong');
    now += ownerPasswordRetryAfterMs(now);
    expect(await checkOwnerPassword(undefined, deps())).toBe('required');
    expect(await checkOwnerPassword('', deps())).toBe('required');
  });

  it('never logs the password', async () => {
    await checkOwnerPassword('wrong horse', deps());
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('wrong horse');
  });

  it('waits 2^n seconds after the nth wrong password, refusing right and wrong alike', async () => {
    expect(await checkOwnerPassword('guess 1', deps())).toBe('wrong');
    expect(ownerPasswordRetryAfterMs(now)).toBe(2_000);
    expect(await checkOwnerPassword('correct horse', deps())).toBe('too-many-attempts');
    now += 2_000;
    expect(await checkOwnerPassword('guess 2', deps())).toBe('wrong');
    expect(ownerPasswordRetryAfterMs(now)).toBe(4_000);
  });

  // Security, #3212 M1: a hard lock let any program on this computer keep the owner out with a
  // few junk passwords per window. The delay caps out, and the right password then gets through.
  it('lets the right password through once the wait passes, however many wrong ones came first', async () => {
    for (let i = 0; i < 12; i++) {
      expect(await checkOwnerPassword(`guess ${i}`, deps())).toBe('wrong');
      now += ownerPasswordRetryAfterMs(now);
    }
    expect(ownerPasswordDelayMs(12)).toBe(OWNER_PASSWORD_MAX_DELAY_MS);
    expect(await checkOwnerPassword('correct horse', deps())).toBe('ok');
    // The right password clears the count.
    expect(ownerPasswordRetryAfterMs(now)).toBe(0);
  });

  // Security, #3212: the slot is claimed before the slow hash check, so guesses sent in parallel
  // do not all slip past the wait while the first one is still being checked.
  it('checks only one of many wrong passwords sent at once', async () => {
    let calls = 0;
    const slow = deps({
      verifier: async () => ({
        storedHash: async () => hash,
        verify: async () => {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return false;
        },
        maxLength: 128,
      }),
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => checkOwnerPassword(`guess ${i}`, slow))
    );
    expect(calls).toBe(1);
    expect(results.filter((r) => r === 'wrong')).toHaveLength(1);
    expect(results.filter((r) => r === 'too-many-attempts')).toHaveLength(9);
  });

  it('does not count a check that found no password to compare against', async () => {
    expect(await checkOwnerPassword('x', deps({ verifier: async () => null }))).toBe('no-password');
    expect(ownerPasswordRetryAfterMs(now)).toBe(0);
  });

  it('forgets wrong passwords older than the window', async () => {
    expect(await checkOwnerPassword('guess', deps())).toBe('wrong');
    now += OWNER_PASSWORD_FAILURE_WINDOW_MS;
    expect(ownerPasswordRetryAfterMs(now)).toBe(0);
  });

  it('says so when there is no owner, or the owner has no password', async () => {
    expect(await checkOwnerPassword('x', deps({ ownerId: () => null }))).toBe('no-owner');
    expect(await checkOwnerPassword('x', deps({ verifier: async () => null }))).toBe('no-password');
    expect(await checkOwnerPassword('x', deps({ ownerId: () => 'user_passkey_only' }))).toBe(
      'no-password'
    );
  });

  it('reads a verifier that fails, or a password past the length cap, as wrong', async () => {
    const failing = deps({
      verifier: async () => ({
        storedHash: async () => hash,
        verify: async () => {
          throw new Error('boom');
        },
        maxLength: 128,
      }),
    });
    expect(await checkOwnerPassword('correct horse', failing)).toBe('wrong');
    now += ownerPasswordRetryAfterMs(now);
    expect(await checkOwnerPassword('x'.repeat(129), deps())).toBe('wrong');
  });

  // DOR-3234 Must 4: a hash at Better Auth's lighter default is rewritten at OWASP's cost the
  // first time the password is known, and only then.
  describe('rewriting a weaker hash', () => {
    function withRehash(stored: () => string) {
      const rehash = vi.fn(async () => undefined);
      const d = deps({
        verifier: async () => ({
          storedHash: async () => stored(),
          verify: verifyOwnerPassword,
          maxLength: 128,
          rehash,
        }),
      });
      return { d, rehash };
    }

    it('rewrites a legacy hash after the right password', async () => {
      const { d, rehash } = withRehash(() => hash);
      expect(await checkOwnerPassword('correct horse', d)).toBe('ok');
      expect(rehash).toHaveBeenCalledExactlyOnceWith('user_owner', 'correct horse');
    });

    it('never rewrites after a wrong password', async () => {
      const { d, rehash } = withRehash(() => hash);
      expect(await checkOwnerPassword('wrong horse', d)).toBe('wrong');
      expect(rehash).not.toHaveBeenCalled();
    });

    it('leaves a hash already at today’s cost alone', async () => {
      const current = await hashOwnerPassword('correct horse');
      const { d, rehash } = withRehash(() => current);
      expect(await checkOwnerPassword('correct horse', d)).toBe('ok');
      expect(rehash).not.toHaveBeenCalled();
    });

    it('still answers ok when the rewrite fails, keeping the old hash', async () => {
      const d = deps({
        verifier: async () => ({
          storedHash: async () => hash,
          verify: verifyOwnerPassword,
          maxLength: 128,
          rehash: async () => {
            throw new Error('disk full');
          },
        }),
      });
      expect(await checkOwnerPassword('correct horse', d)).toBe('ok');
    });
  });
});
