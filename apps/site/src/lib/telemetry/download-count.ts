/**
 * Count each desktop download, anonymously, at the link itself.
 *
 * The site's buttons already report a click (`trackHeroDownload`), but only
 * from a browser that loaded our analytics, and only for clicks on this site.
 * Someone who follows `/download/mac` from GitHub, a post or the docs was never
 * counted. This records one `desktop_download` event per real request to the
 * download links, server-side, so the count matches what was actually served.
 *
 * What it sends, and what it never sends:
 *
 * - **No person.** A fresh random `distinct_id` per request and
 *   `$process_person_profile: false`, so no two downloads can be tied together
 *   and no PostHog person is made. No cookie is read or set.
 * - **No address.** The event goes from this server to PostHog, so PostHog sees
 *   the server's address, never the visitor's; `$geoip_disable` stops it from
 *   placing even that on a map.
 * - **Only coarse context:** the platform, whether a build was served, the
 *   referring site's host name (never its path), and a short `utm_source` /
 *   `utm_campaign` when the link carried them.
 * - **Nothing at all** when the browser sends Global Privacy Control or Do Not
 *   Track (the same signals that pin the site to cookieless capture in
 *   `lib/consent.ts`), for link-preview bots, for a `HEAD` probe (Next answers
 *   one with this same handler), past a per-address limit, or when no project
 *   key is set. The address is used only for that limit, in memory, and is
 *   never sent.
 *
 * Sent after the response with `after()`, so a slow PostHog never delays the
 * redirect, and failures are logged and dropped.
 *
 * @module lib/telemetry/download-count
 */
import { after } from 'next/server';
import { env } from '@/env';
import { createPerIpLimiter } from '@/lib/rate-limit/per-ip-limiter';

/** The desktop builds the download links serve. */
export type DownloadPlatform = 'mac' | 'windows';

/** Per-request cap on the PostHog call; it runs after the response, but must still end. */
const POSTHOG_TIMEOUT_MS = 3000;

/** Link unfurlers and crawlers that follow a link without anyone downloading. */
const BOT_USER_AGENT =
  /bot|crawl|spider|preview|slack|discord|facebookexternalhit|embedly|whatsapp|telegram|skype|vkshare|linkedin/i;

/** Counts per address per window; past it the link still works, it just is not counted. */
export const DOWNLOAD_COUNT_LIMIT = 10;

/** The window {@link DOWNLOAD_COUNT_LIMIT} applies to. */
export const DOWNLOAD_COUNT_WINDOW_MS = 10 * 60 * 1000;

const limiter = createPerIpLimiter({
  limit: DOWNLOAD_COUNT_LIMIT,
  windowMs: DOWNLOAD_COUNT_WINDOW_MS,
});

/** Forget every address the limit has seen (tests). */
export function resetDownloadCountLimit(): void {
  limiter.reset();
}

/** A campaign value we keep: short, and only plain characters. */
const CAMPAIGN_VALUE = /^[a-z0-9._-]{1,64}$/i;

/** Whether the request is a probe, a decline, a link-preview bot, or over the limit. */
function shouldSkip(request: Request): boolean {
  const { headers } = request;
  if (request.method !== 'GET') return true;
  if (headers.get('sec-gpc') === '1' || headers.get('dnt') === '1') return true;
  if (BOT_USER_AGENT.test(headers.get('user-agent') ?? '')) return true;
  return !limiter.consume(request).allowed;
}

/** The referring site's host name, `null` when there is none, never its path. */
function referrerHost(request: Request): string | null {
  const referer = request.headers.get('referer');
  if (!referer) return null;
  try {
    return new URL(referer).hostname || null;
  } catch {
    return null;
  }
}

/** A campaign parameter from the link, kept only when short and plain. */
function campaign(url: URL, name: string): string | null {
  const value = url.searchParams.get(name);
  return value && CAMPAIGN_VALUE.test(value) ? value.toLowerCase() : null;
}

/**
 * The event this request would record, or `null` when nothing may be sent.
 *
 * @param request - The incoming download request.
 * @param platform - Which desktop build the link serves.
 * @param served - Whether a build was found and the visitor was sent to it.
 */
export function buildDownloadEvent(
  request: Request,
  platform: DownloadPlatform,
  served: boolean
): Record<string, unknown> | null {
  if (!env.POSTHOG_PROJECT_KEY || shouldSkip(request)) return null;
  const url = new URL(request.url);
  return {
    event: 'desktop_download',
    distinct_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    properties: {
      platform,
      served,
      referrer_host: referrerHost(request),
      utm_source: campaign(url, 'utm_source'),
      utm_campaign: campaign(url, 'utm_campaign'),
      $process_person_profile: false,
      $geoip_disable: true,
      $lib: 'dorkos-site-download',
    },
  };
}

/** Send one event to PostHog's batch endpoint, logging and dropping any failure. */
async function send(event: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${env.NEXT_PUBLIC_POSTHOG_HOST.replace(/\/+$/, '')}/batch/`, {
      method: 'POST',
      signal: AbortSignal.timeout(POSTHOG_TIMEOUT_MS),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: env.POSTHOG_PROJECT_KEY, batch: [event] }),
    });
  } catch (error) {
    console.error('[lib/telemetry/download-count] download count failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Count one download request, after the response is sent.
 *
 * @param request - The incoming download request.
 * @param platform - Which desktop build the link serves.
 * @param served - Whether a build was found and the visitor was sent to it.
 */
export function countDownload(request: Request, platform: DownloadPlatform, served: boolean): void {
  const event = buildDownloadEvent(request, platform, served);
  if (event) after(() => send(event));
}
