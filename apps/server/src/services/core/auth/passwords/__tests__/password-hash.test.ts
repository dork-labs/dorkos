/**
 * The owner's password hash (DOR-3234): scrypt at OWASP's cost, a hash Better
 * Auth's lighter default wrote still verifies, and says it needs rewriting.
 */
import { describe, expect, it } from 'vitest';
import { hashPassword as hashLegacyPassword } from 'better-auth/crypto';

import {
  OWNER_PASSWORD_SCRYPT,
  hashOwnerPassword,
  needsRehash,
  verifyOwnerPassword,
} from '../password-hash.js';

describe('owner password hash', () => {
  it('is scrypt at no less than OWASP’s floor (N = 2^17, r = 8, p = 1)', () => {
    expect(OWNER_PASSWORD_SCRYPT.N).toBeGreaterThanOrEqual(2 ** 17);
    expect(OWNER_PASSWORD_SCRYPT.r).toBeGreaterThanOrEqual(8);
    expect(OWNER_PASSWORD_SCRYPT.p).toBeGreaterThanOrEqual(1);
  });

  it('names its parameters and verifies only the right password', async () => {
    const hash = await hashOwnerPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$v1\$131072\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    await expect(verifyOwnerPassword({ hash, password: 'correct horse battery' })).resolves.toBe(
      true
    );
    await expect(verifyOwnerPassword({ hash, password: 'correct horse batterY' })).resolves.toBe(
      false
    );
    expect(needsRehash(hash)).toBe(false);
  });

  it('salts every hash afresh', async () => {
    const [a, b] = await Promise.all([hashOwnerPassword('same'), hashOwnerPassword('same')]);
    expect(a).not.toBe(b);
  });

  it('still verifies a hash Better Auth’s default wrote, and says to rewrite it', async () => {
    const legacy = await hashLegacyPassword('correct horse battery');
    await expect(
      verifyOwnerPassword({ hash: legacy, password: 'correct horse battery' })
    ).resolves.toBe(true);
    await expect(verifyOwnerPassword({ hash: legacy, password: 'wrong' })).resolves.toBe(false);
    expect(needsRehash(legacy)).toBe(true);
  });

  it('refuses a stored hash that names an absurd cost, rather than running it', async () => {
    const real = await hashOwnerPassword('x');
    const planted = real.replace('$131072$', `$${2 ** 30}$`);
    await expect(verifyOwnerPassword({ hash: planted, password: 'x' })).rejects.toThrow(
      'Invalid password hash'
    );
    expect(needsRehash(planted)).toBe(true);
  });

  // Security, #3234 read: each factor in range can still multiply to ~4 GiB (N=2^20, r=32).
  it('refuses a stored hash whose N times r passes 2^22, even with each factor in range', async () => {
    const real = await hashOwnerPassword('x');
    const huge = real.replace('$131072$8$', `$${2 ** 20}$32$`);
    await expect(verifyOwnerPassword({ hash: huge, password: 'x' })).rejects.toThrow(
      'Invalid password hash'
    );
  });

  it('says to rewrite a hash in its own format at a lower cost', () => {
    const weaker = `scrypt$v1$16384$8$1$${'a'.repeat(32)}$${'b'.repeat(128)}`;
    expect(needsRehash(weaker)).toBe(true);
  });
});
