/**
 * DorkOS's own addresses, which no agent browser may carry a sign-in for
 * (DOR-3957).
 *
 * Every agent's browser starts from the operator's saved sign-ins. A DorkOS
 * session cookie in that file lets any agent's browser call this app as its
 * owner once login is on, decisions included. So the saved session never holds
 * a cookie, or page storage, for a name this computer's DorkOS answers to:
 * the loopback names, this computer's own names and network addresses, and
 * the tunnel and trusted names the server knows.
 *
 * Matching is by host, never by port: a browser sends a cookie to every port
 * of its host, so a `localhost` cookie set by any local server reaches DorkOS
 * too, and is dropped with the rest.
 *
 * @module shared/app-origin
 */

/** Public DNS names that exist only to point back at this computer. */
const LOOPBACK_DNS =
  /^(?:(?:.+\.)?localhost|(?:.+\.)?localtest\.me|(?:.*[.-])?127[.-]\d+[.-]\d+[.-]\d+\.(?:nip|sslip)\.io)$/;

/**
 * One host in the form every comparison here uses: lower case, no trailing
 * dot, IPv6 in brackets, an IPv4 address embedded in IPv6 written out, and
 * every name for this computer's loopback folded to `localhost`.
 *
 * @param host - A hostname as a URL or a cookie's `domain` holds it.
 */
export function appHostKey(host: string): string {
  // Trailing dots trimmed by hand: `/\.+$/` backtracks on a long run of dots (DOR-3663).
  let end = host.length;
  while (end > 0 && host[end - 1] === '.') end -= 1;
  let key = host.slice(0, end).toLowerCase();
  if (key.includes(':') && !key.startsWith('[')) key = `[${key}]`;
  const embedded = /^\[::(?:ffff:)?([a-f0-9]{1,4}):([a-f0-9]{1,4})\]$/.exec(key);
  if (embedded) {
    const upper = Number.parseInt(embedded[1]!, 16);
    const lower = Number.parseInt(embedded[2]!, 16);
    key = `${upper >> 8}.${upper & 255}.${lower >> 8}.${lower & 255}`;
  }
  if (
    /^127\.\d+\.\d+\.\d+$/.test(key) ||
    ['[::1]', '[::]', '0.0.0.0'].includes(key) ||
    LOOPBACK_DNS.test(key)
  )
    return 'localhost';
  return key;
}

/** One network address, as `os.networkInterfaces()` reports it. */
export interface AppInterfaceAddress {
  address: string;
  family: string;
}

/**
 * The names this computer always answers to, whatever DorkOS is configured
 * with: the loopback names, its hostname, its Bonjour name and every network
 * address it holds. The server adds its tunnel and trusted names on top.
 *
 * @param machine - The computer's hostname (`os.hostname()`).
 * @param interfaces - Its network addresses (`os.networkInterfaces()`).
 */
export function localAppHosts(
  machine: string,
  interfaces: Record<string, readonly AppInterfaceAddress[] | undefined>
): string[] {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0', machine]);
  // The Bonjour name isn't always what hostname() reports.
  hosts.add(`${machine.replace(/\..*$/, '')}.local`);
  for (const addresses of Object.values(interfaces)) {
    for (const { address, family } of addresses ?? []) {
      // A link-local scope is not a URL host. Those addresses cannot be used
      // as browser origins; ordinary IPv6 and IPv4 addresses are included.
      if (address.includes('%')) continue;
      hosts.add(family === 'IPv6' ? `[${address}]` : address);
    }
  }
  return [...hosts];
}

/**
 * A cookie host as the browser reads it, or `null` when it is not a host at
 * all. Chromium accepts other spellings of an address (`127.1`, `2130706433`,
 * `0x7f.0.0.1`, Unicode names), so a host is parsed the way a URL parses it,
 * never compared as raw text. Lower case, no leading or trailing dots, IPv6 in
 * brackets, Unicode in its punycode form.
 *
 * @param host - A cookie's `domain`, or a URL's host name.
 */
export function canonicalCookieHost(host: string): string | null {
  const bare = host.replace(/^\.+/, '');
  if (!bare) return null;
  const literal = bare.includes(':') && !bare.startsWith('[') ? `[${bare}]` : bare;
  let hostname: string;
  try {
    hostname = new URL(`http://${literal}`).hostname;
  } catch {
    return null;
  }
  let end = hostname.length;
  while (end > 0 && hostname[end - 1] === '.') end -= 1;
  return hostname.slice(0, end) || null;
}

/**
 * The `domain` a saved cookie is sent to, as a storage-state file holds it: its
 * own `domain`, or for a cookie set only by `url`, that URL's host (a host-only
 * cookie). `null` when it has neither, or the URL won't parse, so a caller
 * drops it rather than guessing.
 *
 * @param cookie - One cookie, read loosely.
 */
export function cookieDomainOf(cookie: { domain?: unknown; url?: unknown }): string | null {
  if (typeof cookie.domain === 'string' && cookie.domain) return cookie.domain;
  if (typeof cookie.url !== 'string') return null;
  try {
    return new URL(cookie.url).hostname || null;
  } catch {
    return null;
  }
}

function isUnder(host: string, parent: string): boolean {
  return host === parent || host.endsWith(`.${parent}`);
}

/**
 * Whether a browser would send a cookie with this `domain` to DorkOS: set for
 * one of its hosts, or for a parent domain of one (`.lan` reaches `mac.lan`).
 * A `domain` that is not a host at all counts as DorkOS's, so it is dropped.
 *
 * @param domain - The cookie's `domain`, as a storage-state file holds it.
 * @param hosts - DorkOS's hosts, from {@link localAppHosts} plus the server's own.
 */
export function cookieReachesApp(domain: string, hosts: readonly string[]): boolean {
  const isDomainCookie = domain.startsWith('.');
  const canonical = canonicalCookieHost(domain);
  if (canonical === null) return true;
  const cookieHost = appHostKey(canonical);
  return hosts.some((host) => {
    const appHost = appHostKey(canonicalCookieHost(host) ?? host);
    return cookieHost === appHost || (isDomainCookie && isUnder(appHost, cookieHost));
  });
}

/**
 * Whether a page origin is on one of DorkOS's hosts, on any port.
 *
 * @param origin - The origin, as a storage-state file holds it.
 * @param hosts - DorkOS's hosts.
 */
export function isAppHostOrigin(origin: string, hosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const key = appHostKey(parsed.hostname);
  return hosts.some((host) => appHostKey(host) === key);
}

/** The parts of a storage-state file this module reads. */
interface StorageStateLike {
  cookies: Array<{ domain?: string; url?: string }>;
  origins: Array<{ origin: string }>;
}

/**
 * A copy of a saved browser session with every cookie and page storage for
 * DorkOS's own hosts removed, and how many of each it removed.
 *
 * @param state - A Playwright storage state.
 * @param hosts - DorkOS's hosts.
 */
export function withoutAppOrigin<S extends StorageStateLike>(
  state: S,
  hosts: readonly string[]
): { state: S; removedCookies: number; removedOrigins: number } {
  // A cookie with no domain and no url can't be judged, so it goes too.
  const cookies = state.cookies.filter((cookie) => {
    const domain = cookieDomainOf(cookie);
    return domain !== null && !cookieReachesApp(domain, hosts);
  });
  const origins = state.origins.filter((origin) => !isAppHostOrigin(origin.origin, hosts));
  return {
    state: { ...state, cookies, origins },
    removedCookies: state.cookies.length - cookies.length,
    removedOrigins: state.origins.length - origins.length,
  };
}
