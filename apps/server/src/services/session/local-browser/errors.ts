import {
  CLOUD_ORIGIN_REFUSAL,
  cloudOriginEntries,
  isCloudOriginUrl,
  type CloudOriginEntry,
} from '@dorkos/shared/cloud-origin';
import { isLocalBrowserAppUrl, localBrowserAppOrigins, underlyingPageUrl } from './app-origins.js';

/** Machine-readable refusal plus short app copy. Raw Playwright errors never reach the UI. */
export class LocalBrowserError extends Error {
  constructor(
    public readonly code: string,
    message: string
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
