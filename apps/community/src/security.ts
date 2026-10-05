import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Hash a secret before writing it to Postgres. */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * A keyed hash of an email address, for counting and matching mailed-link requests without
 * storing the address.
 *
 * A token is 256 random bits, so its plain SHA-256 ({@link hashSecret}) cannot be reversed. An
 * address can be guessed, and a plain hash of a guess would confirm it, so a leaked table would
 * show who asked. Keyed with the auth secret, the stored value is useless without that secret.
 * The `email-link:` prefix keeps this use of the secret apart from every other HMAC made with it.
 *
 * @param value - The address, already trimmed and lower-cased by the caller.
 * @param secret - The deployment's auth secret.
 * @returns 64 lower-case hex characters.
 */
export function hmacSecret(value: string, secret: string): string {
  return createHmac('sha256', secret).update(`email-link:${value}`).digest('hex');
}

/** Compare deployment secrets without a value-dependent prefix check. */
export function equalSecret(a: string, b: string): boolean {
  const ah = Buffer.from(hashSecret(a), 'hex');
  const bh = Buffer.from(hashSecret(b), 'hex');
  return timingSafeEqual(ah, bh);
}

/** The exact shape of a host API key secret: `dkh_` and 32 random bytes in base64url. */
export const HOST_API_KEY_PATTERN = /^dkh_[A-Za-z0-9_-]{43}$/;

/** Whether a bearer credential claims to be a host API key, so content routes refuse it unread. */
export function isHostApiKeyBearer(authorization: string | undefined): boolean {
  return /^bearer\s+dkh_/i.test(authorization ?? '');
}

/** The credential in an `Authorization: Bearer` header; the scheme name is case-insensitive. */
export function bearerCredential(authorization: string | undefined): string | null {
  return /^bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1] ?? null;
}

/** Mint a host API key secret. The `dkh_` prefix lets secret scanners and log filters find a leak. */
export function mintHostApiKeySecret(): string {
  return `dkh_${randomToken()}`;
}

/** Mint a random opaque grant token. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Sign an opaque cookie value; its database row remains the authority. */
export function signValue(value: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${mac}`;
}

/** Verify an opaque cookie before querying its row. */
export function verifyValue(signed: string | undefined, secret: string): string | null {
  if (!signed) return null;
  const dot = signed.lastIndexOf('.');
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  return equalSecret(signValue(value, secret), signed) ? value : null;
}

/** Read a cookie without echoing its value into errors or logs. */
export function readCookie(header: string | null, name: string): string | undefined {
  const part = header
    ?.split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  return part?.slice(name.length + 1);
}
