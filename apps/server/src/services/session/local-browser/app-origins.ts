/** Live addresses of this DorkOS app, kept out of agent browser tools. */
import { hostname, networkInterfaces } from 'node:os';
import { getStaticLocalOrigins, resolveTrustedOrigins } from '../../../lib/trusted-origins.js';

/** Include local listener aliases even while Wi-Fi access is switched off. */
export function localBrowserAppOrigins(): string[] {
  const origins = new Set(resolveTrustedOrigins());
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0', hostname()]);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const { address, family } of addresses ?? []) {
      // A link-local scope is not a URL host. Those addresses cannot be used
      // as browser origins; ordinary IPv6 and IPv4 addresses are included.
      if (address.includes('%')) continue;
      hosts.add(family === 'IPv6' ? `[${address}]` : address);
    }
  }
  for (const origin of getStaticLocalOrigins()) {
    const parsed = new URL(origin);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    for (const host of hosts) {
      origins.add(`http://${host}:${port}`);
      origins.add(`https://${host}:${port}`);
    }
  }
  return [...origins];
}

/** Normalize local aliases without resolving an outside hostname. */
function originHost(url: URL): string {
  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  const mapped = /^\[::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})\]$/.exec(host);
  if (mapped) {
    const upper = Number.parseInt(mapped[1]!, 16);
    const lower = Number.parseInt(mapped[2]!, 16);
    host = `${upper >> 8}.${upper & 255}.${lower >> 8}.${lower & 255}`;
  }
  if (/^127\.\d+\.\d+\.\d+$/.test(host) || ['[::1]', '[::]', '0.0.0.0'].includes(host))
    return 'localhost';
  return host;
}

/** Compare parsed origins and local aliases, never URL prefixes or substrings. */
export function isLocalBrowserAppUrl(value: string, origins: readonly string[]): boolean {
  let candidate: URL;
  try {
    candidate = new URL(value);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(candidate.protocol)) return false;
  return origins.some((origin) => {
    try {
      const known = new URL(origin);
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
