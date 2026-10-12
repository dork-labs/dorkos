/**
 * `/api/ext/:id/*`: each running extension's own API.
 *
 * Every request under an extension's mount goes to the handler its server
 * half has while it runs (`services/extensions/http/extension-http.ts`): its
 * Express router through the bridge, its `dataProxy`, or the forwarder to its
 * own process. These routes add nothing in front of that but the lookup, and
 * they run behind the whole `/api` chain, so the host guard, the session
 * gate, agent identity and the audit scope apply as to any route.
 *
 * Extensions are code from strangers. One that is not installed, not turned
 * on, not approved to run, or stopped has no handler, and its mount answers
 * `404` before any of its code runs. A path the extension passes on gets the
 * `/api` 404, as it did when the request fell through its Express router.
 *
 * @module routes/extension-api
 */
import { Hono, type Context } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';

/**
 * The mount and the path below it, from the URL as sent: `req.baseUrl` and
 * `req.path` on Express. The route only matched a lower-case `/api/ext/`, so
 * the mount is always its first three segments.
 *
 * @param url - The request URL as sent, with its query.
 */
export function splitExtensionMount(url: string): { mount: string; subPath: string } {
  const pathname = url.split('?')[0] ?? '';
  const parts = pathname.split('/');
  return {
    mount: parts.slice(0, 4).join('/'),
    subPath: `/${parts.slice(4).join('/')}`,
  };
}

/**
 * The `/api/ext` routes.
 *
 * @param manager - Where each extension's handler is looked up, per request,
 *   so turning one off takes effect on the next one.
 * @returns The routes, for `app.route('/api/ext', …)`.
 */
export function createExtensionApiRoutes(
  manager: Pick<ExtensionManager, 'getServerHandler'>
): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();
  const serve = async (c: Context<ApiEnv>): Promise<Response> => {
    const id = c.req.param('id') ?? '';
    const handler = manager.getServerHandler(id);
    if (!handler) return c.json({ error: `Extension '${id}' has no server routes` }, 404);
    const { mount, subPath } = splitExtensionMount(c.env.incoming.url ?? c.req.path);
    return (await handler({ c, mount, subPath })) ?? c.notFound();
  };
  routes.all('/:id', serve);
  routes.all('/:id/*', serve);
  return routes;
}
