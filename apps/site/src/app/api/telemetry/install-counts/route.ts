/**
 * `GET /api/telemetry/install-counts` — public, read-only aggregate install
 * counts for the dorkos-community marketplace.
 *
 * Runs as a Vercel Edge Function. Returns one number per package: the total
 * count of **successful** installs, grouped by package name, for the
 * `dorkos-community` marketplace. These are the same counts already rendered
 * publicly as "N installs" on the marketplace browse and detail pages
 * (`fetchInstallCounts`), so this endpoint exposes nothing new — it is reused
 * here rather than duplicating the query.
 *
 * Privacy + scope contract:
 *   - Aggregate counts only. No event rows, no timestamps, no `installId`, no
 *     request headers (IP, cookies, user agent) — none of it is read or
 *     returned. The response body is `{ counts: Record<packageName, number> }`
 *     and nothing else.
 *   - `fetchInstallCounts` filters to `marketplace = 'dorkos-community'` AND
 *     `outcome = 'success'`, so failed/cancelled installs never appear.
 *
 * Caching: successful responses set a CDN-friendly `Cache-Control` so the
 * aggregate query runs at most once per hour per region, mirroring the hourly
 * ISR the marketplace pages already rely on. On a database error the handler
 * degrades to an empty map with `no-store` (so a transient blip is never cached
 * for an hour) and still responds `200` — a consumer that cannot read counts
 * simply omits the Popular sort.
 *
 * The `telemetry.ts` lib is imported directly (not via the feature barrel) to
 * keep this Edge route free of the barrel's React UI exports.
 *
 * @module app/api/telemetry/install-counts
 */

import { fetchInstallCounts } from '@/layers/features/marketplace/lib/telemetry';

export const runtime = 'edge';

const CACHE_CONTROL_OK = 'public, s-maxage=3600, stale-while-revalidate=86400';
const CACHE_CONTROL_ERROR = 'no-store';

/**
 * Handle the counts read. Always returns `200`; a database failure degrades to
 * an empty map rather than surfacing backend health to callers.
 */
export async function GET(): Promise<Response> {
  try {
    const counts = await fetchInstallCounts();
    return Response.json({ counts }, { headers: { 'Cache-Control': CACHE_CONTROL_OK } });
  } catch (error) {
    console.error('[api/telemetry/install-counts] read failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ counts: {} }, { headers: { 'Cache-Control': CACHE_CONTROL_ERROR } });
  }
}
