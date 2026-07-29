/**
 * Turn the host the server BINDS into a host a local client can DIAL.
 *
 * The two are not the same string in two cases:
 *
 * - **Wildcards.** `0.0.0.0` / `::` mean "listen on every interface" — they are
 *   not dialable addresses. Windows refuses to connect to `0.0.0.0` outright
 *   (`WSAEADDRNOTAVAIL`), and the shipped Docker image sets
 *   `DORKOS_HOST=0.0.0.0`, so a URL minted from the bind host verbatim would be
 *   broken exactly where containers run. A wildcard listener always answers on
 *   loopback, so `localhost` is the honest dial name.
 * - **IPv6 literals.** A bare `::1` inside a URL is unparseable —
 *   `new URL('http://::1:4242')` throws — so literals need brackets: `[::1]`.
 *
 * Everything else (`localhost`, a hostname, an IPv4 literal) passes through
 * unchanged: the server resolved and bound that exact name, so dialing the same
 * name lands on the same address family (the invariant the connections browser
 * spec proved matters — see the mint sites in `index.ts`).
 *
 * @module lib/local-dial-host
 */

/** The bind-host spellings that mean "every interface" rather than an address. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

/**
 * The host a local client should dial to reach a server bound to `bindHost`.
 *
 * @param bindHost - The host the server passed to `listen()` (`env.DORKOS_HOST`).
 * @returns A URL-safe host: wildcards become `localhost`, IPv6 literals gain
 *   brackets, everything else is returned as-is.
 */
export function localDialHost(bindHost: string): string {
  if (WILDCARD_HOSTS.has(bindHost)) return 'localhost';
  // An IPv6 literal is the only host form containing ':'; bracket it for URLs.
  // Already-bracketed input passes through untouched.
  if (bindHost.includes(':') && !bindHost.startsWith('[')) return `[${bindHost}]`;
  return bindHost;
}
