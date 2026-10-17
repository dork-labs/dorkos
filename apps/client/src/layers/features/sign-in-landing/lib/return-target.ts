/**
 * Where the sign-in landing page sends the person back to.
 *
 * - **Desktop app:** a `dorkos://` link, which brings the app forward and, when
 *   a conversation asked for the sign-in, opens that conversation
 *   (`parseDeepLink` in `apps/desktop/src/main/navigation.ts` turns
 *   `dorkos://session?session=abc` into `/session?session=abc`). With no
 *   conversation the link is a bare `dorkos://`, which only brings the app
 *   forward, so the window stays wherever the person left it.
 * - **Browser:** a path on this same origin. Never an absolute URL, so the page
 *   cannot be made to send anyone off DorkOS.
 *
 * @module features/sign-in-landing/lib/return-target
 */
import type { SignInLanding } from '@dorkos/shared/sign-in-landing';

/** Where the page's "Open DorkOS" or "Back to DorkOS" goes. */
export type ReturnTarget =
  { surface: 'desktop'; href: string } | { surface: 'browser'; href: string };

/** The bare desktop link: brings the app forward without moving it. */
export const DESKTOP_FOREGROUND_LINK = 'dorkos://';

/**
 * Whether a path stays on this origin: one leading slash, no second slash or
 * backslash after it (`//evil.example` and `/\evil.example` are other hosts to
 * a browser), and no whitespace. The server builds the path from a plain id, so
 * this is a second fence, not the first.
 *
 * @param path - The path the server recorded.
 */
export function isAppPath(path: string): boolean {
  return /^\/(?![/\\])[^\s\\]*$/.test(path);
}

/**
 * Decide where the page sends the person back to.
 *
 * @param landing - The surface and path the server recorded; a path that fails
 *   {@link isAppPath} is dropped, never followed.
 */
export function returnTarget(
  landing: Pick<SignInLanding, 'returnSurface' | 'returnPath'>
): ReturnTarget {
  const path =
    landing.returnPath !== undefined && isAppPath(landing.returnPath)
      ? landing.returnPath
      : undefined;
  if (landing.returnSurface === 'desktop') {
    return { surface: 'desktop', href: path ? `dorkos:/${path}` : DESKTOP_FOREGROUND_LINK };
  }
  return { surface: 'browser', href: path ?? '/' };
}

/**
 * Whether the page opens the desktop app on its own as soon as it loads: only
 * for a sign-in that finished, started from the desktop app. A failed one stays
 * on the page, where Try again is.
 *
 * @param landing - The recorded outcome.
 */
export function opensDesktopOnLoad(
  landing: Pick<SignInLanding, 'returnSurface' | 'status'>
): boolean {
  return landing.returnSurface === 'desktop' && landing.status === 'connected';
}
