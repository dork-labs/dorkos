import { LocalBrowserError } from '../errors.js';

/**
 * A sign-in page must be `https:`, or `http:` on this computer only.
 *
 * @param value - The address to open.
 */
export function assertSignInUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalBrowserError(
      'unsupported_address',
      'Use a website address starting with https.'
    );
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new LocalBrowserError(
      'unsupported_address',
      'Use a website address starting with https.'
    );
  return url;
}

/**
 * A page's address cut to its site: the origin, or for an address with none
 * (`about:`, `data:`) its scheme alone.
 *
 * @param value - The tab's address.
 */
export function siteOnly(value: string): string {
  try {
    const url = new URL(value);
    if (url.origin !== 'null') return url.origin;
    // A blank tab carries nothing, and the panel names it "New tab".
    return url.href === 'about:blank' ? url.href : url.protocol;
  } catch {
    return '';
  }
}
