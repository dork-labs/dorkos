import type { MiddlewareHandler } from 'hono';

/**
 * The space page's content security policy (DOR-2957). The page runs only its own bundled
 * script: no inline script, no `eval`, nothing from another site. It talks only to this server,
 * so nothing a page does can reach a member's own computer or account.
 *
 * Inline styles stay allowed: the dialogs and menus add a `<style>` element to lock scrolling
 * while they are open. Script is the line that stops an injected page from acting as its reader.
 */
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * The policy on every response that is not the page: the API, live streams, files, exports, the
 * space icon and the built assets. Nothing in one may run, load or be framed, so a file opened
 * directly in a browser tab is inert.
 */
export const LOCKED_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

/** Headers every response carries, page or not. */
const EVERY_RESPONSE = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin',
} as const;

/** The two header sets, by name, that `headers.baseline.json` pins route by route. */
export const SECURITY_HEADER_GROUPS = {
  page: {
    ...EVERY_RESPONSE,
    'content-security-policy': PAGE_CSP,
    'cross-origin-opener-policy': 'same-origin',
  },
  locked: { ...EVERY_RESPONSE, 'content-security-policy': LOCKED_CSP },
} as const satisfies Record<string, Record<string, string>>;

/**
 * Add the security headers to every response once its route has answered, refusals included:
 * an HTML response gets the page's policy, anything else the locked one. Registered first in
 * `createCommunityApp`, so every route and page, however a test serves it, carries them.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const page = /^text\/html\b/iu.test(c.res.headers.get('content-type') ?? '');
    const headers = SECURITY_HEADER_GROUPS[page ? 'page' : 'locked'];
    try {
      for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
    } catch {
      // A response whose headers cannot change (`Response.redirect`) is copied first.
      c.res = new Response(c.res.body, c.res);
      for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
    }
  };
}
