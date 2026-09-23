import type { Hono, MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { parseShortNamePath } from './path.js';

/**
 * Serve the browser page at a community's short address, `/<name>` and anything under it, for
 * any name the grammar allows that is not reserved; every other path falls through to its 404.
 * A name spelled another way (`/Acme`, `/%61cme`) moves permanently to its one spelling, so the
 * server and the browser never disagree about which address a path is.
 */
export function registerShortNamePages(
  app: Hono,
  options: { indexPath: string; reservedNames: ReadonlySet<string> }
): void {
  const page = serveStatic({ path: options.indexPath });
  const serve: MiddlewareHandler = async (c, next) => {
    const url = new URL(c.req.url);
    const named = parseShortNamePath(url.pathname, options.reservedNames);
    if (!named) return next();
    if (!named.canonical) return c.redirect(`/${named.name}${named.rest}${url.search}`, 301);
    return page(c, next);
  };
  app.get('/:name', serve);
  app.get('/:name/*', serve);
}
