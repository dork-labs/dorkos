/** Live addresses of this DorkOS app, kept out of agent browser tools. */
import { hostname, networkInterfaces } from 'node:os';
import { env } from '../../../env.js';
import {
  getStaticLocalOrigins,
  getTunnelHosts,
  isLoopbackHost,
  resolveAuthTrustedOrigins,
} from '../../../lib/trusted-origins.js';
import { parseTrustedHosts } from '../../../middleware/host-guard.js';

/** Marks a list entry that matches its host on any scheme and any port. */
const ANY_PORT = 'dorkos-any-port:';

/** A name DorkOS answers to whatever port or scheme reaches it: a proxy's port isn't ours. */
function anyPortEntry(host: string): string {
  return `${ANY_PORT}//${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}`;
}

/** Include local listener aliases even while Wi-Fi access is switched off. */
export function localBrowserAppOrigins(): string[] {
  const origins = new Set(resolveAuthTrustedOrigins());
  for (const host of getTunnelHosts()) origins.add(anyPortEntry(host));
  // Loopback names stay port-bound, so an agent's own server on another port still works.
  for (const host of parseTrustedHosts(env.DORKOS_TRUSTED_HOSTS))
    if (!isLoopbackHost(host)) origins.add(anyPortEntry(host));
  const machine = hostname();
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0', machine]);
  // The Bonjour name isn't always what hostname() reports.
  hosts.add(`${machine.replace(/\..*$/, '')}.local`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const { address, family } of addresses ?? []) {
      // A link-local scope is not a URL host. Those addresses cannot be used
      // as browser origins; ordinary IPv6 and IPv4 addresses are included.
      if (address.includes('%')) continue;
      hosts.add(family === 'IPv6' ? `[${address}]` : address);
    }
  }
  const ports = getStaticLocalOrigins().map((origin) => {
    const parsed = new URL(origin);
    return parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  });
  if (env.DORKOS_TLS_PORT) ports.push(String(env.DORKOS_TLS_PORT));
  for (const port of ports) {
    for (const host of hosts) {
      origins.add(`http://${host}:${port}`);
      origins.add(`https://${host}:${port}`);
    }
  }
  return [...origins];
}

/** Public DNS names that exist only to point back at this computer. */
const LOOPBACK_DNS =
  /^(?:(?:.+\.)?localhost|(?:.+\.)?localtest\.me|(?:.*[.-])?127[.-]\d+[.-]\d+[.-]\d+\.(?:nip|sslip)\.io)$/;

/** Normalize local aliases without resolving an outside hostname. */
function originHost(url: URL): string {
  let host = url.hostname.toLowerCase().replace(/\.+$/, '');
  const embedded = /^\[::(?:ffff:)?([a-f0-9]{1,4}):([a-f0-9]{1,4})\]$/.exec(host);
  if (embedded) {
    const upper = Number.parseInt(embedded[1]!, 16);
    const lower = Number.parseInt(embedded[2]!, 16);
    host = `${upper >> 8}.${upper & 255}.${lower >> 8}.${lower & 255}`;
  }
  if (
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    ['[::1]', '[::]', '0.0.0.0'].includes(host) ||
    LOOPBACK_DNS.test(host)
  )
    return 'localhost';
  return host;
}

/** The address a tab really shows: `view-source:` and `blob:` wrap the page's own address. */
export function underlyingPageUrl(value: string): string {
  return value.replace(/^(?:view-source:|blob:)+/i, '');
}

/** Compare parsed origins and local aliases, never URL prefixes or substrings. */
export function isLocalBrowserAppUrl(value: string, origins: readonly string[]): boolean {
  let candidate: URL;
  try {
    candidate = new URL(underlyingPageUrl(value));
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(candidate.protocol)) return false;
  return origins.some((origin) => {
    try {
      const known = new URL(origin);
      if (known.protocol === ANY_PORT) return originHost(candidate) === originHost(known);
      return (
        candidate.protocol === known.protocol &&
        candidate.port === known.port &&
        originHost(candidate) === originHost(known)
      );
    } catch {
      // A bad dynamic tunnel address must not disable the other refusals.
      return false;
    }
  });
}
