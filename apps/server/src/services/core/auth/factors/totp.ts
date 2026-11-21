/**
 * Authenticator-app codes (TOTP, RFC 6238) for the owner's second factor
 * (DOR-3647).
 *
 * The usual settings every authenticator app reads: HMAC-SHA1, 6 digits, a
 * 30-second step, the secret as base32. A code is accepted for the current step
 * and one step either side, for clocks that drift, and never for a step at or
 * before the last one accepted, so a code cannot be used twice.
 *
 * @module services/core/auth/factors/totp
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Seconds per step. */
export const TOTP_STEP_SECONDS = 30;

/** Digits per code. */
export const TOTP_DIGITS = 6;

/** Steps either side of now a code may come from. */
const DRIFT_STEPS = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Base32 (RFC 4648, no padding) of some bytes.
 *
 * @param bytes - The bytes.
 */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    // Keep only the bits not yet written, so the number never overflows.
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The bytes a base32 string names; spaces, padding and case ignored.
 *
 * @param text - The base32 text.
 * @throws When it holds a character base32 does not.
 */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Not base32.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, as base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * The code for one step (RFC 4226 HOTP over the step counter).
 *
 * @param secret - The base32 secret.
 * @param step - The step number.
 */
export function totpCodeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return String(binary).padStart(TOTP_DIGITS, '0');
}

/**
 * The step a moment falls in.
 *
 * @param now - The time in ms.
 */
export function totpStepOf(now: number): number {
  return Math.floor(now / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Check a typed code: the step it matches, or `null` when it matches none
 * near now, or only one already used.
 *
 * @param secret - The base32 secret.
 * @param typed - The code as typed; spaces ignored.
 * @param lastStep - The last step a code was accepted for, if any.
 * @param now - The current time, for tests.
 */
export function verifyTotp(
  secret: string,
  typed: string,
  lastStep: number | null,
  now = Date.now()
): number | null {
  const code = typed.replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStepOf(now);
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step += 1) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = Buffer.from(totpCodeAt(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

/**
 * The `otpauth://` address an authenticator app reads from a QR code.
 *
 * @param secret - The base32 secret.
 * @param account - What the app lists it as, beside "DorkOS".
 */
export function totpUri(secret: string, account: string): string {
  const label = encodeURIComponent(`DorkOS:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer: 'DorkOS',
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
