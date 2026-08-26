/**
 * Naming the caller of a public API route, for per-client rate limiting
 * (DOR-1581).
 *
 * @module lib/rate-limit/client-ip
 */

/** Bucket key used when a request carries no client-IP header. */
export const UNKNOWN_CLIENT_IP = 'unknown';

/**
 * Read the calling client's IP from proxy headers.
 *
 * On Vercel the platform edge sets `x-forwarded-for` (client first, then each
 * proxy hop) and `x-real-ip`, so the first hop is the caller. Off Vercel —
 * local `next dev`, or a direct request — neither header exists and every such
 * request shares the {@link UNKNOWN_CLIENT_IP} bucket. Sharing rather than
 * skipping is deliberate: an unidentifiable caller must not get a free pass
 * around the limit.
 *
 * @param headers - The incoming request's headers.
 * @returns The client IP, or {@link UNKNOWN_CLIENT_IP}.
 */
export function clientIpFromHeaders(headers: Headers): string {
  const firstHop = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (firstHop) return firstHop;

  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;

  return UNKNOWN_CLIENT_IP;
}
