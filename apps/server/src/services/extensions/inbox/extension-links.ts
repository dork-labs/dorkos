/**
 * Which links an extension may hand core (spec `flow-multiproject` §7.1,
 * invariant 11).
 *
 * A decision's `link`, a `word` action's `href`, and the `navigate` an action
 * handler answers with are all followed by core's own UI, in the person's
 * app, and a `link` also becomes the deep link a phone push opens. So each one
 * must be an in-app path: a route the app's router serves (the same
 * `APP_ROUTE_PATHS` list the client's link seam reads), or a page under the
 * raising extension's OWN `/x/<id>` prefix. Anything else is refused: an
 * absolute URL, a protocol-relative `//host`, `javascript:` and `data:`, a
 * backslash trick, and another extension's `/x/<other>/…` (one extension must
 * not be able to send a person to a page another extension draws).
 *
 * @module services/extensions/extension-links
 */
import { APP_ROUTE_PATHS } from '@dorkos/shared/app-route-paths';

const APP_ROUTE_SET: ReadonlySet<string> = new Set(APP_ROUTE_PATHS);

/** A base no real link can share, so a parsed link that changes origin is caught. */
const PROBE_ORIGIN = 'http://dorkos.invalid';

/** Longest link core keeps. */
const MAX_LINK_LENGTH = 2048;

/**
 * Whether `url` is an in-app path an extension may hand core.
 *
 * @param url - The link as the extension gave it.
 * @param extensionId - The extension handing it over; only its own `/x/<id>` pages pass.
 */
export function isAllowedExtensionLink(url: unknown, extensionId: string): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_LINK_LENGTH) return false;
  // Exactly one leading slash, and no backslash anywhere: `//host` and `/\host`
  // are both read by a browser as another origin.
  if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\')) return false;
  // No control characters or whitespace, which URL parsing silently strips.
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  if (/[\u0000-\u001f\u007f\s]/.test(url)) return false;
  // No `.` or `..` segments: the check below reads the resolved path, and the
  // client must follow exactly the path that was checked.
  if (/(^|\/)\.{1,2}(\/|$|\?|#)/.test(url)) return false;

  let parsed: URL;
  try {
    parsed = new URL(url, PROBE_ORIGIN);
  } catch {
    return false;
  }
  if (parsed.origin !== PROBE_ORIGIN) return false;

  const pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : '/';
  if (APP_ROUTE_SET.has(pathname)) return true;

  const own = `/x/${extensionId}`;
  return pathname === own || pathname.startsWith(`${own}/`);
}
