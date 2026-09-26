import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

/**
 * The network address a per-caller limit counts against.
 *
 * By default it is the socket peer, the one address a caller cannot forge. Behind a reverse
 * proxy that peer is the proxy itself, so every caller would share one limit. A host whose proxy
 * always sets a client-address header (for example `Fly-Client-IP`, or `X-Forwarded-For`) names
 * it in `COMMUNITY_TRUSTED_PROXY_HEADER`; the address is then read from that header. Only the
 * last comma-separated entry is used, because a proxy appends the address it saw after anything
 * the caller sent. A request without the header falls back to the socket peer.
 *
 * Never set the header on a server that callers can reach without the proxy: anyone could then
 * send it and pick their own limit bucket.
 */
export function callerAddress(c: Context, trustedProxyHeader: string | undefined): string {
  if (trustedProxyHeader) {
    const forwarded = c.req.header(trustedProxyHeader)?.split(',').at(-1)?.trim();
    if (forwarded) return forwarded;
  }
  return getConnInfo(c).remote.address ?? 'unknown';
}
