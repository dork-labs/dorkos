/**
 * Passcode hashing utilities using Node.js crypto.scrypt.
 *
 * Uses a 32-byte random salt and 64-byte derived key. Verification uses
 * timing-safe comparison to prevent timing attacks.
 *
 * @module lib/passcode-hash
 */
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

/** Hash a plaintext passcode with a random salt. Returns hex-encoded hash and salt. */
export async function hashPasscode(passcode: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(32).toString('hex');
  const derived = (await scryptAsync(passcode, salt, KEY_LENGTH)) as Buffer;
  return { hash: derived.toString('hex'), salt };
}

/** Verify a plaintext passcode against a stored hash and salt using timing-safe comparison. */
export async function verifyPasscode(
  passcode: string,
  storedHash: string,
  storedSalt: string
): Promise<boolean> {
  const derived = (await scryptAsync(passcode, storedSalt, KEY_LENGTH)) as Buffer;
  const hashBuffer = Buffer.from(storedHash, 'hex');
  if (derived.length !== hashBuffer.length) return false;
  return timingSafeEqual(derived, hashBuffer);
}
