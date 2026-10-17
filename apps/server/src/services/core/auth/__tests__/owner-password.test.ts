/**
 * The owner-password step-up (DOR-2946): checked by Better Auth's own hashing,
 * throttled globally, and refusing rather than opening on anything odd.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { logger } from '../../../../lib/logger.js';
import {
  OWNER_PASSWORD_FAILURE_WINDOW_MS,
  OWNER_PASSWORD_MAX_FAILURES,
  checkOwnerPassword,
  resetOwnerPasswordFailuresForTests,
  type OwnerPasswordDeps,
} from '../owner-password.js';

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
    expect(await checkOwnerPassword(undefined, deps())).toBe('required');
    expect(await checkOwnerPassword('', deps())).toBe('required');
  });

  it('never logs the password', async () => {
    await checkOwnerPassword('wrong horse', deps());
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('wrong horse');
  });

  it('refuses every attempt, right or wrong, past the global cap, until the window clears', async () => {
    for (let i = 0; i < OWNER_PASSWORD_MAX_FAILURES; i++) {
      expect(await checkOwnerPassword(`guess ${i}`, deps())).toBe('wrong');
    }
    expect(await checkOwnerPassword('correct horse', deps())).toBe('too-many-attempts');
    now += OWNER_PASSWORD_FAILURE_WINDOW_MS;
    expect(await checkOwnerPassword('correct horse', deps())).toBe('ok');
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
    expect(await checkOwnerPassword('x'.repeat(129), deps())).toBe('wrong');
  });
});
