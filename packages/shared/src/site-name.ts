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
