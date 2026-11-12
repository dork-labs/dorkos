/**
 * Only DorkOS's own service worker may be installed from this origin
 * (DOR-3547, Security M-A).
 *
 * A mini app's code is served from DorkOS's own origin, so without this a
 * mini app could register a service worker there. A worker can read every
 * page it controls, including the page where a person lets a mini app read a
 * connected app, and act as that page. Browsers fetch a worker's script with
 * `Service-Worker: script`, a header no page can set, so refusing every such
 * fetch except DorkOS's own `/sw.js` closes that door for every path,
 * extension routes included. Nothing here ever sends `Service-Worker-Allowed`
 * (and extension replies have it stripped), so DorkOS's own worker can't be
 * widened either; it intercepts no request at all (`apps/client/public/sw.js`).
 *
 * Asked near the start of the chain (`http/api-chain.ts`), ahead of every route.
 *
 * @module middleware/service-worker-guard
 */
import type { MiddlewareHandler } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';

/** The one worker script this origin serves: DorkOS's push notifications. */
export const DORKOS_SERVICE_WORKER_PATH = '/sw.js';

/** Refuse a service worker script fetch for anything but DorkOS's own worker. */
export const refuseForeignServiceWorkers: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const fetchingWorker = c.env.incoming.headers['service-worker'] === 'script';
  if (fetchingWorker && c.req.path !== DORKOS_SERVICE_WORKER_PATH) {
    return c.json({ error: 'Only DorkOS’s own service worker runs here.' }, 403);
  }
  await next();
};
