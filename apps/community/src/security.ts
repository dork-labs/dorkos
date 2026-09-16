import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Hash a secret before writing it to Postgres. */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Compare deployment secrets without a value-dependent prefix check. */
export function equalSecret(a: string, b: string): boolean {
  const ah = Buffer.from(hashSecret(a), 'hex');
  const bh = Buffer.from(hashSecret(b), 'hex');
  return timingSafeEqual(ah, bh);
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
