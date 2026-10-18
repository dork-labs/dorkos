import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { LINK_SECRET_SCRIPT } from './link-secret-script.js';

declare module 'hono' {
  interface ContextVariableMap {
    /** Set by {@link servePage}: this request is answered by the space page itself. */
    spacePage: true;
  }
}

/** The page policy's source for its one inline script: the hash of exactly that text. */
const LINK_SECRET_SCRIPT_SOURCE = `'sha256-${createHash('sha256').update(LINK_SECRET_SCRIPT).digest('base64')}'`;

/**
 * The space page's content security policy (DOR-2957). The page runs only its own bundled
 * script and one inline script allowed by its hash, the one that takes a link's secret out of
 * the address bar (`link-secret-script.ts`): no other inline script, no `eval`, nothing from
 * another site. It talks only to this server, so nothing a page does can reach a member's own
 * computer or account.
 *
 * Inline styles stay allowed: the dialogs and menus add a `<style>` element to lock scrolling
 * while they are open. Script is the line that stops an injected page from acting as its reader.
 */
export const PAGE_CSP = [
  "default-src 'none'",
  `script-src 'self' ${LINK_SECRET_SCRIPT_SOURCE}`,
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
 * Serve the space page from its built `index.html`, marked as the page so it gets the page
 * policy. Every path that opens the page uses this, and nothing else does.
 *
 * @param indexPath - The built page's `index.html`.
 */
export function servePage(indexPath: string): MiddlewareHandler {
  const serve = serveStatic({ path: indexPath });
  return (c, next) => {
    c.set('spacePage', true);
    return serve(c, next);
  };
}

/**
 * Add the security headers to every response once its route has answered, refusals included.
 * The page policy goes only to the page, as {@link servePage} serves it; every other response
 * gets the locked one, whatever its content type, so a library's own HTML (Better Auth's error
 * page) never runs as the page. Registered first in `createCommunityApp`, so every route and
 * page, however a test serves it, carries them.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const page =
      c.get('spacePage') === true &&
      /^text\/html\b/iu.test(c.res.headers.get('content-type') ?? '');
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
