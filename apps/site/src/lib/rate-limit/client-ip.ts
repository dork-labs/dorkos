/**
 * Naming the caller of a public API route, for per-client rate limiting
 * (DOR-1581).
 *
 * **The header is only as trustworthy as whoever set it.** On Vercel the
 * platform sets `x-real-ip` and *overwrites* `x-forwarded-for` with the single
 * connecting address — external hops are not forwarded, so behind Vercel there
 * is no hop list to pick from and both headers say the same true thing.
 * `x-real-ip` is preferred because it is the single-value header
 * `@vercel/functions`' own `ipAddress()` reads.
 *
 * Off the platform — `next start`, a local dev server, a future host that does
 * not rewrite headers — every one of these values is whatever the client typed.
 * That is why a comma-separated `x-forwarded-for` is **rejected outright**
 * rather than mined for element zero: taking the first hop of a list the caller
 * controls is the classic wrong trust model, and it would let one abuser mint
 * an unlimited supply of fresh buckets by rotating a fake leading hop, or slip
 * past an exhausted bucket by prepending one. A value we cannot trust is worth
 * less than no value: it falls back to the shared {@link UNKNOWN_CLIENT_IP}
 * bucket, where an unidentifiable caller is throttled alongside every other
 * unidentifiable caller instead of being handed a private allowance.
 *
 * @module lib/rate-limit/client-ip
 */

/** Bucket key used when a request carries no trustworthy client-IP header. */
export const UNKNOWN_CLIENT_IP = 'unknown';

/**
 * Longest header value accepted as a bucket key. The longest textual IPv6
 * address is 45 characters, so this is generous — its real job is to stop an
 * 8KB header from becoming an 8KB Map key, which at the limiter's 10,000-key
 * ceiling would be ~80MB held by one warm instance.
 */
const MAX_KEY_LENGTH = 64;

/** Dotted-quad IPv4, each octet 0-255. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Hex-and-colon IPv6, including the IPv4-mapped `::ffff:1.2.3.4` form. Loose on
 * purpose: this is a shape check that keeps junk out of the key space, not an
 * address parser, and a malformed address that passes only ever buckets its own
 * sender.
 */
const IPV6 = /^[0-9a-fA-F:]*:[0-9a-fA-F:.]*$/;

/** Whether `value` looks like a single IP address and nothing else. */
function isPlausibleIp(value: string): boolean {
  const v4 = IPV4.exec(value);
  if (v4) return v4.slice(1).every((octet) => Number(octet) <= 255);
  return IPV6.test(value);
}

/** Trim and accept a header value only if it is one plausible, bounded IP. */
function asBucketKey(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (!value || value.length > MAX_KEY_LENGTH) return null;
  return isPlausibleIp(value) ? value : null;
}

/**
 * Read the calling client's IP from proxy headers.
 *
 * Prefers `x-real-ip`, then `x-forwarded-for`. Anything that is not a single
 * bounded IP address — a hop list, an empty string, an oversized value, junk —
 * is refused, and the caller shares the {@link UNKNOWN_CLIENT_IP} bucket.
 *
 * @param headers - The incoming request's headers.
 * @returns The client IP, or {@link UNKNOWN_CLIENT_IP}.
 */
export function clientIpFromHeaders(headers: Headers): string {
  const realIp = asBucketKey(headers.get('x-real-ip'));
  if (realIp) return realIp;

  const forwardedFor = asBucketKey(headers.get('x-forwarded-for'));
  if (forwardedFor) return forwardedFor;

  return UNKNOWN_CLIENT_IP;
}
