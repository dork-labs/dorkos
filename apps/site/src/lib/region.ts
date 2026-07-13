/**
 * Region classification for the site's consent model. A visitor is either in a
 * **gated** region (opt-in consent banner required before cookie-based
 * analytics) or an **open** region (analytics on by default under the US-style
 * opt-out regime). The classification is derived on the edge from Vercel's geo
 * header and handed to the client through the `dorkos_region` cookie.
 *
 * The gated set is the union of the jurisdictions that require prior opt-in for
 * analytics cookies: the EU-27, the three non-EU EEA states, the United Kingdom,
 * and Switzerland. **Anything not positively identified as open fails closed to
 * gated** — an unknown, empty, or missing country is treated as gated, so a
 * geo-detection gap can never silently drop a visitor into on-by-default
 * capture.
 *
 * Kept dependency-free (no zod, no Next imports) so it is safe to import from
 * both `proxy.ts` (edge runtime) and client components.
 *
 * @module lib/region
 */

/** The name of the strictly-necessary cookie carrying the edge-computed region to the client. */
export const REGION_COOKIE = 'dorkos_region';

/**
 * Whether a visitor sees the opt-in consent banner (`gated`) or gets
 * analytics on by default with a one-click off switch (`open`).
 */
export type Region = 'gated' | 'open';

/**
 * ISO 3166-1 alpha-2 codes whose visitors must opt in before any cookie-based
 * analytics: the EU-27 + the non-EU EEA states (Iceland, Liechtenstein,
 * Norway) + the United Kingdom + Switzerland.
 */
const GATED_COUNTRIES: ReadonlySet<string> = new Set([
  // EU-27
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  // Non-EU EEA
  'IS',
  'LI',
  'NO',
  // United Kingdom + Switzerland
  'GB',
  'CH',
]);

/**
 * Classifies a country code into a consent region. Case-insensitive.
 *
 * Fails closed to `'gated'` when the country is unknown: a `null`/`undefined`/
 * empty value (a missing geo header from local dev or a non-Vercel host) or
 * Vercel's `'XX'` sentinel for an unresolved IP. A known country that simply
 * is not in the gated set (e.g. `'US'`, `'JP'`) is `'open'` — we know where the
 * visitor is, it just is not an opt-in-first jurisdiction.
 *
 * @param country - ISO 3166-1 alpha-2 code, e.g. from the `x-vercel-ip-country` header.
 */
export function classifyRegion(country: string | null | undefined): Region {
  if (!country) return 'gated';
  const code = country.trim().toUpperCase();
  // Vercel emits 'XX' when it cannot resolve the IP to a country — treat that
  // unknown like a missing header and fail closed.
  if (code === '' || code === 'XX') return 'gated';
  return GATED_COUNTRIES.has(code) ? 'gated' : 'open';
}

/**
 * Parses the `dorkos_region` cookie value the edge set. Only the exact string
 * `'open'` yields an open region; every other value (including a missing
 * cookie) fails closed to `'gated'`, matching {@link classifyRegion}.
 *
 * @param value - The raw cookie value, or `undefined` when the cookie is absent.
 */
export function parseRegionCookie(value: string | null | undefined): Region {
  return value === 'open' ? 'open' : 'gated';
}
