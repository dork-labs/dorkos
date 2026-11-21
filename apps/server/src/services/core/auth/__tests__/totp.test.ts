/**
 * Authenticator-app codes (`factors/totp.ts`, DOR-3647), against the RFC 6238
 * test vectors.
 */
import { describe, expect, it } from 'vitest';

import {
  base32Decode,
  base32Encode,
  newTotpSecret,
  totpCodeAt,
  totpStepOf,
  totpUri,
  verifyTotp,
} from '../factors/totp.js';

/** RFC 6238 appendix B's SHA-1 seed, "12345678901234567890", as base32. */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('TOTP codes', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('matches the RFC 6238 vector at %i s', (seconds, code) => {
    // The RFC lists 8 digits; the 6-digit code is its last six.
    expect(totpCodeAt(RFC_SECRET, totpStepOf(seconds * 1000))).toBe(code);
  });

  it('round-trips base32', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7, 99]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Decode(newTotpSecret())).toHaveLength(20);
  });

  it('accepts the code for now and one step either side', () => {
    const now = 1_800_000_000_000;
    const step = totpStepOf(now);
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, step), null, now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, step + 1), null, now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, step - 2), null, now)).toBeNull();
  });

  it('never accepts a code for a step already used', () => {
    const now = 1_800_000_000_000;
    const step = totpStepOf(now);
    const code = totpCodeAt(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, step, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, step - 1, now)).toBe(step);
  });

  it('refuses anything but six digits', () => {
    for (const typed of ['', '12345', '1234567', 'abcdef', '12 34 5a']) {
      expect(verifyTotp(RFC_SECRET, typed, null)).toBeNull();
    }
  });

  it('writes the address an authenticator app reads', () => {
    const uri = new URL(totpUri('ABCDEF', 'owner@dork.test'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.searchParams.get('secret')).toBe('ABCDEF');
    expect(uri.searchParams.get('issuer')).toBe('DorkOS');
    expect(uri.searchParams.get('digits')).toBe('6');
  });
});
