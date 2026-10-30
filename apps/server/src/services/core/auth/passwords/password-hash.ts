/**
 * How this computer stores the owner's password (DOR-3234).
 *
 * A step-up ("Confirm it's you") rests on an agent not knowing the owner's
 * password. The server throttles guesses it is sent (`../owner-password.ts`), but
 * a program running as the same OS user can read the stored hash off disk and
 * guess offline, where no throttle reaches. So the hash has to cost real work
 * per guess.
 *
 * **The hash:** scrypt at N = 2^17, r = 8, p = 1, 64-byte key, a fresh 16-byte
 * salt per password, the password NFKC-normalized first. That is OWASP's
 * Password Storage Cheat Sheet floor for scrypt (about 128 MiB and a few
 * hundred milliseconds per guess). Better Auth's own default, which every
 * password stored before this used, is N = 2^14, r = 16: a quarter of the work.
 *
 * Stored as `scrypt$v1$<N>$<r>$<p>$<salt hex>$<key hex>`, so the parameters
 * travel with the hash and can rise again later without a migration. A hash in
 * Better Auth's own `salt:key` format still verifies, through Better Auth's
 * own code, and {@link needsRehash} says it should be rewritten: the owner's
 * next good password step-up does that (`../owner-password.ts`).
 *
 * Lengths stay Better Auth's: at least 8 characters, at most 128, checked
 * before hashing (Security, #3212 review).
 *
 * @module services/core/auth/passwords/password-hash
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { verifyPassword as verifyLegacyPassword } from 'better-auth/crypto';

/** The scrypt parameters every new password hash uses. */
export const OWNER_PASSWORD_SCRYPT = { N: 2 ** 17, r: 8, p: 1, keyLength: 64 } as const;

/** The prefix of a hash this module wrote, in its first format. */
const PREFIX = 'scrypt$v1$';

/** Bytes of fresh salt per password. */
const SALT_BYTES = 16;

/** The largest cost a stored hash may name, so a planted hash cannot stall the server. */
const MAX_N = 2 ** 20;

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** Run scrypt with enough memory headroom for the parameters asked. */
function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      OWNER_PASSWORD_SCRYPT.keyLength,
      { ...params, maxmem: 256 * params.N * params.r },
      (error, key) => (error ? reject(error) : resolve(key))
    );
  });
}

/**
 * Hash a password for storage, at {@link OWNER_PASSWORD_SCRYPT}.
 *
 * @param password - The password as typed.
 */
export async function hashOwnerPassword(password: string): Promise<string> {
  const { N, r, p } = OWNER_PASSWORD_SCRYPT;
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, { N, r, p });
  return `${PREFIX}${N}$${r}$${p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** A stored hash in this module's format, read back, or `null` when it is not one. */
function parse(hash: string): (ScryptParams & { salt: Buffer; key: Buffer }) | null {
  if (!hash.startsWith(PREFIX)) return null;
  const [n, r, p, salt, key] = hash.slice(PREFIX.length).split('$');
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  const sane =
    Number.isSafeInteger(params.N) &&
    params.N > 1 &&
    params.N <= MAX_N &&
    (params.N & (params.N - 1)) === 0 &&
    Number.isSafeInteger(params.r) &&
    params.r >= 1 &&
    params.r <= 32 &&
    Number.isSafeInteger(params.p) &&
    params.p >= 1 &&
    params.p <= 4 &&
    /^[0-9a-f]+$/.test(salt ?? '') &&
    /^[0-9a-f]+$/.test(key ?? '');
  if (!sane) return null;
  return { ...params, salt: Buffer.from(salt!, 'hex'), key: Buffer.from(key!, 'hex') };
}

/**
 * Whether a password matches a stored hash, in either format. Throws on a hash
 * in neither, as Better Auth's own verify does.
 *
 * @param input - The stored hash and the password as typed.
 */
export async function verifyOwnerPassword(input: {
  hash: string;
  password: string;
}): Promise<boolean> {
  if (!input.hash.startsWith(PREFIX)) return verifyLegacyPassword(input);
  const stored = parse(input.hash);
  if (!stored) throw new Error('Invalid password hash');
  const key = await derive(input.password, stored.salt, stored);
  return key.length === stored.key.length && timingSafeEqual(key, stored.key);
}

/**
 * Whether a stored hash is weaker than {@link OWNER_PASSWORD_SCRYPT} and should
 * be rewritten the next time the password is known.
 *
 * @param hash - The stored hash.
 */
export function needsRehash(hash: string): boolean {
  const stored = parse(hash);
  if (!stored) return true;
  const { N, r, p } = OWNER_PASSWORD_SCRYPT;
  return stored.N * stored.r < N * r || stored.p < p;
}
