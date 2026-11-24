/**
 * The PostHog `before_send` hook for dorkos.ai (DOR-4992).
 *
 * `/privacy` says the site does not log what you type. Two things PostHog
 * sends on its own would break that, so every event passes through
 * {@link scrubAnalyticsEvent} on its way out:
 *
 * - **URLs.** PostHog puts the page's address on events under many names
 *   (`$current_url`, `$initial_current_url`, `$session_entry_url`, the
 *   referrers, web-vitals and heatmap payloads keyed by URL), and an address
 *   can carry a search, like `/marketplace?q=…`. Rather than trust a list of
 *   names, the hook walks every property, value and key, nested ones too, and
 *   scrubs anything that reads as an address: a dorkos.ai `/marketplace` page
 *   keeps its `type` and `category` filters when they name a real type or
 *   category; every other address loses its whole query string and hash.
 *   Campaign tags survive: PostHog records them as their own `utm_*`
 *   properties before this hook runs.
 * - **Error text.** PostHog Error Tracking captures uncaught errors itself
 *   (`capture_exceptions` in `instrumentation-client.ts`) as well as the ones
 *   the error boundaries hand it. Each `$exception` leaves with its message
 *   emptied and the fields that repeat it dropped; the walk above takes the
 *   query strings off its stack frames' URLs.
 *
 * @module lib/telemetry/before-send
 */
import type { CaptureResult } from 'posthog-js';
import { links } from '@dorkos/shared/links';

import { isKnownCategory, isKnownPackageType } from './marketplace-filters';

/** The catalog filters a dorkos.ai marketplace address may keep, with their check. */
const KEPT_PARAMS = [
  ['type', isKnownPackageType],
  ['category', isKnownCategory],
] as const;

/** The site's own host, from the links module. */
const SITE_HOST = new URL(links.site).hostname;
/** Hosts whose `/marketplace` addresses keep their catalog filters: the site and its `www.`. */
const OWN_HOSTS = new Set([SITE_HOST, `www.${SITE_HOST}`]);

/** How deep the walk goes; PostHog's payloads are a few levels at most. */
const MAX_DEPTH = 8;

/** Fields PostHog may put on an `$exception` that carry message text. */
const MESSAGE_FIELDS = ['$exception_message', '$exception_values', '$exception_steps'] as const;

/** The site's origin, so a bare path parses as one of the site's own addresses. */
const PATH_BASE = links.site;

/** Whether a host is this site: dorkos.ai, or the deploy the page runs on. */
function isOwnHost(host: string): boolean {
  if (OWN_HOSTS.has(host)) return true;
  return typeof window !== 'undefined' && window.location?.hostname === host;
}

/**
 * Cut an address down to what analytics may keep. A dorkos.ai `/marketplace`
 * address keeps `type` and `category` when each names a real package type or
 * catalog category; anything else keeps no query at all, and nothing keeps
 * its hash. A string that is not an absolute http(s) address or a path, or
 * that carries no `?` or `#`, comes back as it was.
 *
 * @param value - Any property value.
 */
export function scrubUrl(value: unknown): unknown {
  if (typeof value !== 'string' || !/[?#]/.test(value)) return value;
  const isPath = value.startsWith('/') && !value.startsWith('//');
  if (!isPath && !/^https?:\/\//i.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value, isPath ? PATH_BASE : undefined);
  } catch {
    return value.replace(/[?#][\s\S]*$/, '');
  }
  const kept = new URLSearchParams();
  const ours = isPath || isOwnHost(url.hostname);
  if (ours && (url.pathname === '/marketplace' || url.pathname === '/marketplace/')) {
    for (const [key, isKnown] of KEPT_PARAMS) {
      const v = url.searchParams.get(key);
      if (v !== null && isKnown(v)) kept.set(key, v);
    }
  }
  const query = kept.toString();
  const base = isPath ? url.pathname : `${url.origin}${url.pathname}`;
  return query ? `${base}?${query}` : base;
}

/**
 * Scrub every string in a value, nested objects and arrays included, and every
 * object key that is itself an address. Two keys that scrub to the same address
 * keep both values: arrays are joined, anything else keeps the last one. Past
 * {@link MAX_DEPTH} a branch is dropped rather than sent unread.
 */
function scrubDeep(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubUrl(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, depth + 1));
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = scrubUrl(rawKey) as string;
    const next = scrubDeep(rawValue, depth + 1);
    const prev = out[key];
    out[key] = Array.isArray(prev) && Array.isArray(next) ? [...prev, ...next] : next;
  }
  return out;
}

/** Empty one `$exception_list` entry's message. */
function emptyMessage(entry: unknown): unknown {
  return entry && typeof entry === 'object' ? { ...entry, value: '' } : entry;
}

/**
 * PostHog `before_send` hook: scrub every address in the event, and the error
 * text on every `$exception`, keeping the type, level and frames Error
 * Tracking groups on. A `null` (an event an earlier hook dropped) passes
 * through.
 *
 * @param event - The event PostHog is about to send.
 */
export function scrubAnalyticsEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  const properties = scrubDeep(event.properties ?? {}, 0) as Record<string, unknown>;
  if (event.event === '$exception') {
    for (const field of MESSAGE_FIELDS) delete properties[field];
    const list = properties.$exception_list;
    if (Array.isArray(list)) properties.$exception_list = list.map(emptyMessage);
  }
  const scrubbed: CaptureResult = { ...event, properties };
  if (event.$set) scrubbed.$set = scrubDeep(event.$set, 0) as CaptureResult['$set'];
  if (event.$set_once)
    scrubbed.$set_once = scrubDeep(event.$set_once, 0) as CaptureResult['$set_once'];
  return scrubbed;
}
