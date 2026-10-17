/**
 * How an OAuth callback answers the browser once its sign-in has finished.
 *
 * The callback records the outcome (`services/core/sign-in-landing/sign-in-landings.ts`) and
 * redirects to the app's `/signed-in?landing=<id>` page, so the person sees the
 * real app, in their own theme, and the OAuth `code` and `state` leave the
 * address bar before anyone can copy them. The redirect is `303 See Other` and
 * carries `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, so the
 * callback URL is neither re-requested nor handed to the page it leads to.
 *
 * Only a production server with no client build to serve cannot show that
 * page. It answers with a small page of its own instead: the same words, light
 * or dark from the system setting, no script and no outside asset.
 *
 * @module http/sign-in-landing-response
 */
import type { Context } from 'hono';
import type { SignInLanding } from '@dorkos/shared/sign-in-landing';
import { getLocalCockpitOrigin } from '../lib/trusted-origins.js';
import {
  landingLocation,
  signInLandings,
  type SignInLandingInput,
} from '../services/core/sign-in-landing/sign-in-landings.js';
import { clientBuildPresent, clientDistPath } from './client-dist.js';

/** Headers every answer to a callback carries: it must not be cached or leak its URL. */
const CALLBACK_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
} as const;

/**
 * Record a finished sign-in and send the browser to its landing page.
 *
 * @param c - The callback's request context.
 * @param input - What the sign-in came to.
 * @returns A redirect into the app, or the fallback page when there is no app to show.
 */
export function respondWithSignInLanding(c: Context, input: SignInLandingInput): Response {
  const id = signInLandings.record(input);
  const dist = clientDistPath();
  if (dist !== undefined && !clientBuildPresent(dist)) {
    const landing = signInLandings.get(id);
    if (landing) {
      return c.body(renderFallbackPage(landing), landing.status === 'connected' ? 200 : 400, {
        ...CALLBACK_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      });
    }
  }
  const location = landingLocation(id, {
    servesApp: dist !== undefined,
    cockpitOrigin: getLocalCockpitOrigin(),
  });
  return c.body(null, 303, { ...CALLBACK_HEADERS, Location: location });
}

/** Escape the five characters HTML gives meaning to. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The heading and line under it, in the same words the app's page uses
 * (`features/sign-in-landing`). Every sentence is fixed; only the service's
 * name is filled in, and it is escaped where it is placed.
 */
function fallbackCopy(landing: SignInLanding): { heading: string; body: string } {
  // Empty when the callback no longer knew the service; only failures say so.
  const name = landing.serviceName;
  if (landing.status === 'connected') {
    return {
      heading: `Signed in to ${name}`,
      body: landing.resumesConversation
        ? 'Your agent is picking up where it left off. You can close this tab.'
        : `${name} is ready to use. You can close this tab.`,
    };
  }
  switch (landing.reason) {
    case 'cancelled':
      return { heading: 'Sign-in cancelled', body: 'Nothing changed. Start again from DorkOS.' };
    case 'expired':
      return {
        heading: 'This sign-in link expired',
        body: 'Start a new sign-in from DorkOS.',
      };
    default:
      return {
        heading: 'Couldn’t finish signing in',
        body: `${name || 'The service'} didn’t complete the sign-in. Try again from DorkOS.`,
      };
  }
}

/**
 * The page a production server without a client build answers with.
 *
 * @param landing - The recorded outcome.
 */
function renderFallbackPage(landing: SignInLanding): string {
  const { heading, body } = fallbackCopy(landing);
  const ok = landing.status === 'connected';
  const mark = ok
    ? '<path d="M5 12.5l4.2 4.2L19 7" />'
    : '<path d="M12 7.5v5.5" /><path d="M12 16.5h.01" />';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(heading)} · DorkOS</title>
<style>
:root{--bg:#fafafa;--card:#fff;--fg:#171717;--muted:#737373;--line:#e5e5e5;--ok:#16a34a;--warn:#d97706}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--card:#171717;--fg:#fafafa;--muted:#a3a3a3;--line:#262626;--ok:#4ade80;--warn:#fbbf24}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:24rem;padding:2rem;border:1px solid var(--line);border-radius:1rem;background:var(--card);text-align:center}
svg{width:2.5rem;height:2.5rem;margin:0 auto 1rem;display:block;fill:none;stroke:${ok ? 'var(--ok)' : 'var(--warn)'};stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
h1{margin:0 0 .5rem;font-size:1.125rem;font-weight:600;letter-spacing:-.01em}
p{margin:0;color:var(--muted)}
</style>
</head>
<body>
<main>
<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" />${mark}</svg>
<h1>${escapeHtml(heading)}</h1>
<p>${escapeHtml(body)}</p>
</main>
</body>
</html>
`;
}
