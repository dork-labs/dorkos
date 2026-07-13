/**
 * Derives PostHog's region-specific hosts from the single configured ingest
 * host (`NEXT_PUBLIC_POSTHOG_HOST`), so switching between the US and EU
 * regions is one env var instead of three. Consumed by both `next.config.ts`
 * (the `/hub` reverse-proxy rewrite, server-side) and
 * `instrumentation-client.ts` (the `ui_host` passed to `posthog.init`,
 * client-side) — kept dependency-free (no zod, no Next imports) so it is safe
 * to import from both.
 *
 * @module lib/posthog-host
 */

const INGEST_HOST_PATTERN = /^https:\/\/(us|eu)\.i\.posthog\.com\/?$/;

/** The PostHog region embedded in an ingest host, or `null` for a custom host. */
function regionOf(ingestHost: string): 'us' | 'eu' | null {
  const match = ingestHost.match(INGEST_HOST_PATTERN);
  return match ? (match[1] as 'us' | 'eu') : null;
}

/**
 * The `-assets` ingest host PostHog serves static assets (recorder, toolbar
 * scripts) from, matching the region of `ingestHost`. Falls back to
 * `ingestHost` itself for a custom/self-hosted host, where no separate
 * assets host is assumed.
 *
 * @param ingestHost - `NEXT_PUBLIC_POSTHOG_HOST`, e.g. `https://us.i.posthog.com`
 */
export function deriveAssetHost(ingestHost: string): string {
  const region = regionOf(ingestHost);
  return region ? `https://${region}-assets.i.posthog.com` : ingestHost;
}

/**
 * The `*.posthog.com` host PostHog's toolbar and generated links use,
 * matching the region of `ingestHost`. Defaults to the US UI host when the
 * region can't be determined.
 *
 * @param ingestHost - `NEXT_PUBLIC_POSTHOG_HOST`, e.g. `https://us.i.posthog.com`
 */
export function deriveUiHost(ingestHost: string): string {
  const region = regionOf(ingestHost) ?? 'us';
  return `https://${region}.posthog.com`;
}
