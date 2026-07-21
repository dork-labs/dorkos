/**
 * `GET /api/telemetry/updated-at` — public, read-only registry recency for the
 * dorkos-community marketplace.
 *
 * Runs as a Vercel Edge Function. Returns one ISO 8601 timestamp per package:
 * the date of the last commit that touched the package's directory in the
 * `dork-labs/marketplace` registry (see {@link fetchRegistryUpdatedAt}). This is
 * public git history — the same registry the marketplace browse pages already
 * render — so the endpoint exposes nothing new.
 *
 * Scope contract:
 *   - Registry timestamps only. No event rows, no `installId`, no request
 *     headers (IP, cookies, user agent) — none of it is read or returned. The
 *     response body is `{ updatedAt: Record<packageName, isoString> }` and
 *     nothing else.
 *   - Only packages whose files live inside the registry repo carry a date; a
 *     package sourced from an external repo has no registry directory and is
 *     omitted, so a wrong date is never invented.
 *
 * Caching: successful responses set a CDN-friendly `Cache-Control` so the
 * per-package GitHub lookups run at most once per hour per region, mirroring the
 * hourly ISR the marketplace pages already rely on. On a failure the handler
 * degrades to an empty map with `no-store` (so a transient blip is never cached
 * for an hour) and still responds `200` — a consumer that cannot read dates
 * simply omits the Recent sort.
 *
 * @module app/api/telemetry/updated-at
 */

import { fetchRegistryUpdatedAt } from '@/layers/features/marketplace/lib/updated-at';

export const runtime = 'edge';

const CACHE_CONTROL_OK = 'public, s-maxage=3600, stale-while-revalidate=86400';
const CACHE_CONTROL_ERROR = 'no-store';

/**
 * Handle the recency read. Always returns `200`; a registry or GitHub failure
 * degrades to an empty map rather than surfacing backend health to callers.
 */
export async function GET(): Promise<Response> {
  try {
    const updatedAt = await fetchRegistryUpdatedAt();
    return Response.json({ updatedAt }, { headers: { 'Cache-Control': CACHE_CONTROL_OK } });
  } catch (error) {
    console.error('[api/telemetry/updated-at] read failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ updatedAt: {} }, { headers: { 'Cache-Control': CACHE_CONTROL_ERROR } });
  }
}
