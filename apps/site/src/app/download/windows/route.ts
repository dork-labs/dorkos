/**
 * `GET /download/windows` — the stable human download link for the DorkOS
 * desktop app on Windows.
 *
 * Looks up the newest published GitHub release of dork-labs/dorkos that
 * carries a `.exe` asset and 302-redirects to it. See
 * {@link findLatestExeDownloadUrl} for why this can't just link at
 * `/releases/latest` directly.
 *
 * Returns a 503 with a short plain-text body when no such release exists
 * yet (nothing shipped, or the GitHub lookup failed) — live day-one
 * behavior before the first desktop release with a `.exe` asset ships.
 *
 * The Windows build is an unsigned early alpha (no verified end-to-end
 * install yet, per the demo-claim gate in AGENTS.md) — Windows will show a
 * SmartScreen "Windows protected your PC" prompt until it is signed.
 *
 * @module app/download/windows
 */
import { findLatestExeDownloadUrl } from '@/lib/desktop-download';

export const runtime = 'nodejs';

/** Redirect to the newest `.exe` release asset, or 503 when none exists. */
export async function GET(): Promise<Response> {
  const url = await findLatestExeDownloadUrl();
  if (!url) {
    return new Response('No Windows desktop build is available yet.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  return Response.redirect(url, 302);
}
