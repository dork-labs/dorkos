/**
 * `/api/ext/:id/*`: each running extension's own API.
 *
 * Every request under an extension's mount goes to the handler its server
 * half has while it runs (`services/extensions/http/extension-http.ts`): its
 * `dataProxy`, its fetch handler, or the forwarder to its own process. These routes add nothing in front of that but the lookup, and
 * they run behind the whole `/api` chain, so the host guard, the session
 * gate, agent identity and the audit scope apply as to any route.
 *
 * Extensions are code from strangers. One that is not installed, not turned
 * on, not approved to run, or stopped has no handler, and its mount answers
 * `404` before any of its code runs. A path every handler passes on gets the
 * `/api` 404.
 *
 * @module routes/extension-api
 */
import { Hono, type Context } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';

/**
 * The mount and the path below it: `req.baseUrl` and `req.path` on Express.
 *
 * Both come from the URL the route matched, never the request target as
 * sent: the URL has an absolute-form target reduced to its path and its dot
 * segments resolved, so the mount always names the extension the lookup
 * found, and the path below it is that extension's own.
 *
 * @param url - The request's URL, as the route matched it.
 * @param id - The extension id the route matched.
 */
export function splitExtensionMount(url: string, id: string): { mount: string; subPath: string } {
  // `/api/ext/<id>/…`: the path below the mount starts at the fourth segment.
  const parts = new URL(url).pathname.split('/');
  return {
    mount: `/api/ext/${id}`,
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
    const { mount, subPath } = splitExtensionMount(c.req.url, id);
    return (await handler({ c, mount, subPath })) ?? c.notFound();
  };
  routes.all('/:id', serve);
  routes.all('/:id/*', serve);
  return routes;
}
