/**
 * The name a person knows a site by: google.com for accounts.google.com (DOR-4097).
 *
 * Display only, never a security boundary: anything that decides access keeps the
 * full host. The list of two-part endings is the common ones, not the Public
 * Suffix List; a rare ending shows one label longer, which still keeps the end.
 */

/** Second-level endings that take a third label to name a site. */
const TWO_PART_ENDINGS = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'co.nz',
  'org.nz',
  'co.jp',
  'ne.jp',
  'or.jp',
  'co.kr',
  'co.in',
  'co.za',
  'com.br',
  'com.mx',
  'com.ar',
  'com.cn',
  'com.hk',
  'com.sg',
  'com.tr',
  'com.tw',
]);

/**
 * The site's registrable name for display. An IP address, `localhost` or any
 * one-label name stays as it is; a port is dropped; case is lowered.
 *
 * @param host - A host from an address, with or without a port.
 */
export function siteName(host: string): string {
  const lower = host.toLowerCase();
  if (lower.startsWith('[')) return lower.slice(0, lower.indexOf(']') + 1);
  const name = lower.replace(/:\d+$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return name;
  const labels = name.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const keep = TWO_PART_ENDINGS.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-keep).join('.');
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
