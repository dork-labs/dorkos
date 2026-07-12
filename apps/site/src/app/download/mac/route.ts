/**
 * `GET /download/mac` — the stable human download link for the DorkOS
 * desktop app on macOS.
 *
 * Looks up the newest published GitHub release of dork-labs/dorkos that
 * carries a `.dmg` asset and 302-redirects to it. See
 * {@link findLatestDmgDownloadUrl} for why this can't just link at
 * `/releases/latest` directly.
 *
 * Returns a 503 with a short plain-text body when no such release exists
 * yet (nothing shipped, or the GitHub lookup failed) — live day-one
 * behavior before the first desktop release with a `.dmg` asset ships.
 *
 * @module app/download/mac
 */
import { findLatestDmgDownloadUrl } from '@/lib/desktop-download';

export const runtime = 'nodejs';

/** Redirect to the newest `.dmg` release asset, or 503 when none exists. */
export async function GET(): Promise<Response> {
  const url = await findLatestDmgDownloadUrl();
  if (!url) {
    return new Response('No macOS desktop build is available yet.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  return Response.redirect(url, 302);
}
