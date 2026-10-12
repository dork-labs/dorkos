/**
 * The bridge that keeps an extension's Express `router` working on the Hono
 * server: the one place in DorkOS's own routing where Express still runs
 * (ADR `261009-192542`, DOR-2810).
 *
 * An extension's `register(router, ctx)` fills an Express router. Each router
 * gets a tiny private Express app that mounts it at `/api/ext/:id`, exactly
 * where the server's Express app used to mount the extension middleware, and
 * each request is handed to that app as the raw Node pair (`c.env.incoming`,
 * `c.env.outgoing`), the way the front door handed requests to Express. What
 * the router sees is therefore what it saw before:
 *
 * - **Its mount.** `req.baseUrl` is `/api/ext/<id>` as sent, `req.path` and
 *   `req.url` are below it, `req.originalUrl` is the whole URL, and
 *   `req.params` holds only the router's own parameters.
 * - **Its body.** The `/api` chain has already run the app-wide JSON parser,
 *   as `express.json` ran before the old mount, so `req.body` holds parsed
 *   JSON and an extension's own `express.json()` passes. A body that parser
 *   does not read (text, a form, a file) is still unread for the router.
 * - **Who asked.** The session user and the agent the chain resolved are on
 *   `res.locals`, where `ctx.requirePerson` reads them; `req.ip` trusts one
 *   proxy hop, as the server's app did.
 * - **Failures.** A route that throws, rejects or calls `next(err)` is
 *   answered by the chain's error handler, with the same status and body the
 *   Express error handler gave. A path the router does not serve passes on to
 *   the `/api` 404. Nothing an extension route throws reaches the process.
 *
 * One thing the server's Express app added is left out, as on every route
 * that moved: the `X-Powered-By` header. The `ETag` that `res.send` computes
 * is still there, since the router's own response methods write the reply.
 *
 * @module services/extensions/http/express-bridge
 */
import type { ServerResponse } from 'node:http';
import express, { type Request, type Response as ExpressResponse, type Router } from 'express';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import type { ExtensionHttpHandler } from './extension-http.js';

/**
 * Serve one extension's Express router through its own private Express app.
 *
 * @param router - The router the extension's `register()` filled.
 * @returns The handler: the marker once the router answered, `null` when it
 *   passed the request on, or the router's error thrown to the chain.
 */
export function bridgeExpressRouter(router: Router): ExtensionHttpHandler {
  const app = express();
  app.disable('x-powered-by');
  // One trusted hop, as `app.ts` set it: `req.ip` reads the same.
  app.set('trust proxy', 1);
  app.use('/api/ext/:id', router);

  return async ({ c }) => {
    // A router with no routes (an extension that serves with `fetch` only)
    // has nothing to answer: Express never runs for it.
    if (router.stack.length === 0) return null;
    const { incoming, outgoing } = c.env;
    // What the Express chain's identity steps put on `res.locals`, which
    // `ctx.requirePerson` and any extension reading the caller expect there.
    const locals: Record<string, unknown> = Object.create(null);
    const user = c.get('user');
    const agentIdentity = c.get('agentIdentity');
    if (user) locals.user = user;
    if (agentIdentity) locals.agentIdentity = agentIdentity;
    (outgoing as ServerResponse & { locals?: Record<string, unknown> }).locals = locals;

    return new Promise<Response | null>((resolve, reject) => {
      // The router answered: the request lasts as long as its response, as a
      // handed-off request did at the front door.
      const answered = (): void =>
        resolve(new Response(null, { headers: RESPONSE_ALREADY_SENT.headers }));
      outgoing.once('close', answered);
      app(incoming as Request, outgoing as ExpressResponse, (error?: unknown) => {
        outgoing.off('close', answered);
        if (error) reject(error);
        else resolve(null);
      });
    });
  };
}
