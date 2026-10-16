import { join } from 'node:path';
import type { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { servePage } from '../headers/security-headers.js';
import { COMMUNITY_PATH_SHORT_NAMES } from '@dorkos/shared/community-admin-wire';
import { COMMUNITY_EMAIL_LINK_PAGES } from '@dorkos/shared/community-wire';
import { registerShortNamePages } from '../short-names/pages.js';

/**
 * Serve the browser page: its built assets and every path that opens it. Registered after the
 * API, so an API route always answers first. `main.ts` passes the built `dist/` folder; the route
 * census and the page contract pass a folder of their own.
 */
export function registerPages(app: Hono, { distDir }: { distDir: string }): void {
  const indexPath = join(distDir, 'index.html');
  const page = () => servePage(indexPath);
  app.use('/assets/*', serveStatic({ root: distDir }));
  app.get('/', page());
  app.get('/host', page());
  app.get('/join', page());
  app.get('/claim', page());
  app.get('/pairing', page());
  // The owner's object-only link from the email, and the new owner's claim link. Both carry their
  // token after `#`, so it never reaches this server's logs.
  app.get('/keep-ownership', page());
  app.get('/owner-replacement', page());
  // The pages a mailed reset, sign-in or confirmation link opens. Each carries its token after
  // `#`, so it never reaches this server's logs, and nothing happens on load: the page asks first.
  for (const path of Object.values(COMMUNITY_EMAIL_LINK_PAGES)) app.get(path, page());
  app.get('/c/:communityId', page());
  app.get('/c/:communityId/*', page());
  registerShortNamePages(app, {
    indexPath,
    // Only paths are never a short address; every other reserved name is served, and the lookup
    // opens it only when a host operator gave it to a space.
    reservedNames: new Set(COMMUNITY_PATH_SHORT_NAMES),
  });
}
