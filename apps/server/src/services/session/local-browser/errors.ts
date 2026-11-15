import {
  CLOUD_ORIGIN_REFUSAL,
  cloudOriginEntries,
  isCloudOriginUrl,
  type CloudOriginEntry,
} from '@dorkos/shared/cloud-origin';
import { isLocalBrowserAppUrl, localBrowserAppOrigins, underlyingPageUrl } from './app-origins.js';

/** Machine-readable refusal plus short app copy. Raw Playwright errors never reach the UI. */
export class LocalBrowserError extends Error {
  /**
   * A refusal with a code an agent can act on.
   *
   * @param code - The refusal an agent can act on.
   * @param message - DorkOS's own words; never text from a page, a chat or a person.
   * @param fields - Untrusted text (a chat's title) kept beside the sentence, never in it.
   */
  constructor(
    public readonly code: string,
    message: string,
    public readonly fields?: Readonly<Record<string, string | null>>
  ) {
    super(message);
  }
}

/** The refusal an agent gets for a page on the Cloud origin (DOR-3196). */
export function cloudOriginRefusal(): LocalBrowserError {
  return new LocalBrowserError('cloud_origin', CLOUD_ORIGIN_REFUSAL);
}

/** Agents use DorkOS tools rather than driving the app's person-only controls. */
export function appOriginRefusal(): LocalBrowserError {
  return new LocalBrowserError('dorkos_origin', 'Use DorkOS tools to work in the app.');
}

/**
 * The refusal an agent gets for a tab or frame it may not read: Cloud, this
 * app, or a local file, under any address that wraps them. Null when allowed.
 *
 * @param urls - The tab's address and its frames' addresses.
 * @param cloudOrigins - The Cloud origin list.
 * @param appOrigins - The live addresses of this DorkOS app.
 */
export function protectedPageRefusal(
  urls: readonly string[],
  cloudOrigins: readonly CloudOriginEntry[],
  appOrigins: readonly string[]
): LocalBrowserError | null {
  const pages = urls.map(underlyingPageUrl);
  if (pages.some((url) => isCloudOriginUrl(url, cloudOrigins))) return cloudOriginRefusal();
  if (pages.some((url) => isLocalBrowserAppUrl(url, appOrigins))) return appOriginRefusal();
  if (pages.some((url) => /^file:/i.test(url)))
    return new LocalBrowserError(
      'unsupported_address',
      'Use a website address starting with http or https.'
    );
  return null;
}

/**
 * Keep browser navigation on websites rather than browser settings or local
 * files. Agents also stay off this app and Cloud; the person may go there.
 * The person may also open `about:blank`, exactly that and nothing else under
 * `about:`, which is the address bar's "new empty page" (DOR-4419).
 *
 * @param value - The address to open.
 * @param who - Who asked: an agent unless the person's own control said so.
 * @param cloudOrigins - The Cloud origin list.
 * @param appOrigins - The live addresses of this DorkOS app.
 */
export function assertLocalBrowserUrl(
  value: string,
  who: 'agent' | 'person' = 'agent',
  cloudOrigins: readonly CloudOriginEntry[] = cloudOriginEntries(),
  appOrigins: readonly string[] = localBrowserAppOrigins()
): void {
  if (who === 'person' && value === 'about:blank') return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LocalBrowserError(
      'unsupported_address',
      'Use a website address starting with http or https.'
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new LocalBrowserError(
      'unsupported_address',
      'Use a website address starting with http or https.'
    );
  if (who === 'agent' && isCloudOriginUrl(value, cloudOrigins)) throw cloudOriginRefusal();
  if (who === 'agent' && isLocalBrowserAppUrl(value, appOrigins)) throw appOriginRefusal();
}

/** Chromium's words for a page that never connected: refused, timed out or unreachable. */
const UNREACHABLE =
  /net::ERR_(?:CONNECTION_REFUSED|CONNECTION_TIMED_OUT|TIMED_OUT|ADDRESS_UNREACHABLE)\b/;

/**
 * Why a person's navigation failed, as a refusal. A page that never connected
 * is `navigation_unreachable`, which is what lets the address bar try
 * `http://` once for a bare host the person typed. Anything else, a
 * certificate error included, stays `navigation_uncertain`: the page may have
 * half-loaded, and a certificate error must never be stepped around.
 *
 * @param error - What Playwright's `goto` threw.
 */
export function navigationRefusal(error: unknown): LocalBrowserError {
  const message = error instanceof Error ? error.message : '';
  const timedOut = error instanceof Error && error.name === 'TimeoutError';
  if (timedOut || UNREACHABLE.test(message))
    return new LocalBrowserError('navigation_unreachable', 'Couldn’t reach that site.');
  return new LocalBrowserError(
    'navigation_uncertain',
    'Couldn’t finish opening the page. Check the browser.'
  );
}

/** One recovery message for setup cancelled before the browser is ready. */
export function browserSetupCancelled(): LocalBrowserError {
  return new LocalBrowserError('cancelled', 'Browser setup stopped. Open it again to continue.');
}
