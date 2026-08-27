/**
 * The `429` a person can actually read (DOR-1586).
 *
 * Most throttled routes answer machines, so they answer in JSON. The newsletter
 * confirm and unsubscribe links are different: they are clicked out of an email
 * client, and whoever clicked them is looking at a browser window. A JSON blob
 * there tells a subscriber their link is broken. This is a small standalone
 * page instead, styled inline because a route handler serves no stylesheet.
 *
 * The colors are the site's own tokens, copied as literals for the same reason.
 * Keep them in step with `app/globals.css` if the palette ever moves; a drift
 * here is cosmetic on one rarely-seen page, never a broken build.
 *
 * @module lib/rate-limit/too-many-requests-page
 */

/** Site palette, inlined (see module doc). */
const CREAM = '#f5f0e6';
const CHARCOAL = '#1a1814';
const WARM_GRAY = '#4a4640';

/** Escape the few characters that could otherwise break out of the markup. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build the `429` page a throttled email link returns.
 *
 * @param heading - Short title, e.g. `'One moment'`.
 * @param message - One or two plain sentences saying what to do next.
 * @returns Complete HTML for a standalone page.
 */
export function tooManyRequestsHtml(heading: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(heading)} — DorkOS</title>
</head>
<body style="margin:0;background:${CREAM};color:${CHARCOAL};font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;">
<main style="max-width:36rem;margin:0 auto;padding:6rem 1.5rem;text-align:center;">
<h1 style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.5rem;font-weight:700;margin:0;">${escapeHtml(heading)}</h1>
<p style="color:${WARM_GRAY};font-size:1.125rem;line-height:1.6;margin:1rem 0 0;">${escapeHtml(message)}</p>
</main>
</body>
</html>
`;
}

/**
 * A `429` response carrying {@link tooManyRequestsHtml} and a `Retry-After`.
 *
 * @param heading - Short title for the page.
 * @param message - One or two plain sentences saying what to do next.
 * @param retryAfterSeconds - Whole seconds until this caller's window resets.
 * @returns The response to return from the route handler.
 */
export function tooManyRequestsPage(
  heading: string,
  message: string,
  retryAfterSeconds: number
): Response {
  return new Response(tooManyRequestsHtml(heading, message), {
    status: 429,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'retry-after': String(retryAfterSeconds),
      'cache-control': 'no-store',
    },
  });
}
