import { getDomain, parse } from 'tldts';

// Private suffixes name independent owners too: alice.github.io is not bob.github.io.
const PSL_OPTIONS = { allowPrivateDomains: true, extractHostname: false } as const;

/** Only WHATWG-normalized hostnames reach the PSL; unknown suffix guesses grant nothing. */
function registrableDomain(hostname: string): string | null {
  const result = parse(hostname, PSL_OPTIONS);
  if (!result.isIcann && !result.isPrivate) return null;
  return getDomain(hostname, PSL_OPTIONS);
}

/**
 * Authority key for one schemeful site, never the display helper's fallback.
 * Unknown/nonregistrable names and opaque URLs return null: callers must drop,
 * never compare two null keys. IP literals use the exact origin; localhost and IDN hosts never renew control.
 *
 * @param value - The trusted committed page URL, never a display name.
 */
export function schemefulSiteKey(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const hostname = url.hostname;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return null;
  // A display-normalized IDN is not proof of an unambiguous owner for held renewal.
  if (hostname.split('.').some((label) => label.startsWith('xn--'))) return null;
  if (parse(hostname, PSL_OPTIONS).isIp) return url.origin;
  const domain = registrableDomain(hostname);
  return domain ? `${url.protocol}//${domain}` : null;
}

/**
 * The site's registrable name for display. An IP address, `localhost` or any
 * one-label name stays as it is; a port is dropped; case is lowered. Unknown
 * suffixes keep a display-only last-label fallback, never an authority key.
 *
 * @param host - A host from an address, with or without a port.
 */
export function siteName(host: string): string {
  const lower = host.toLowerCase();
  if (lower.startsWith('[')) return lower.slice(0, lower.indexOf(']') + 1);
  const name = lower.replace(/:\d+$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return name;
  try {
    const domain = registrableDomain(new URL(`https://${name}`).hostname);
    if (domain) return domain;
  } catch {
    // Display-only fallback for names that are not registrable web hosts.
  }
  const labels = name.split('.').filter(Boolean);
  return labels.slice(-2).join('.');
}

/**
 * The end of a host that the address bar must always show whole (DOR-4655): the
 * longer of {@link siteName} and the host's last three labels, so a page can never
 * hide which site it is on behind a long, trusted-looking start
 * (`accounts.google.com.attacker.example` keeps `com.attacker.example`). A host of
 * three labels or fewer, an IP address, `localhost` or any one-label name is
 * kept whole. A port stays on the end it belongs to.
 *
 * Only what may be elided is decided here; the address bar elides from the left,
 * before this part, and never inside it.
 *
 * @param host - A URL's host as `URL.host` gives it: lowercase, punycode, with any port.
 */
export function keptHostTail(host: string): string {
  if (host.startsWith('[')) return host;
  const port = /:\d+$/.exec(host)?.[0] ?? '';
  const name = port ? host.slice(0, -port.length) : host;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return host;
  const labels = name.split('.');
  if (labels.length <= 3) return host;
  const keep = Math.max(siteName(name).split('.').length, 3);
  return `${labels.slice(-keep).join('.')}${port}`;
}
