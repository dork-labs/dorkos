/** Human browser setup and controls. Agent actions travel through the capability gate. */
import { Hono } from 'hono';
import { z } from 'zod';
import { LocalBrowserOpenSchema } from '@dorkos/shared/local-browser';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { isLocalCaller, refuseUnlessAccountOwner } from '../lib/caller-authority.js';
import {
  LocalBrowserError,
  type LocalBrowserService,
} from '../services/session/local-browser/service.js';

/** Mount owner-only human controls under /api/local-browser. */
export function createLocalBrowserRoutes(service: LocalBrowserService): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.use('*', async (c, next) => {
    const facts = honoRequestFacts(c);
    if (!isLocalCaller(facts))
      return c.json(
        { error: 'Use DorkOS on this computer to control its browser.', code: 'local_only' },
        403
      );
    if (refuseUnlessAccountOwner(facts) !== undefined)
      return c.json(
        { error: 'Only this DorkOS owner can choose its browser.', code: 'owner_only' },
        403
      );
    return next();
  });
  router.onError((error, c) => {
    if (error instanceof LocalBrowserError)
      return c.json({ error: error.message, code: error.code }, 409);
    if (error instanceof z.ZodError)
      return c.json(
        { error: 'Check your browser choice and try again.', code: 'bad_request' },
        400
      );
    return c.json({ error: 'Couldn’t use the browser. Try again.', code: 'browser_error' }, 500);
  });
  router.get('/capabilities', (c) => c.json(service.capabilities()));
  router.get('/state', async (c) => c.json(await service.state()));
  router.post('/open', async (c) =>
    c.json(await service.open(LocalBrowserOpenSchema.parse(readJsonBody(c))))
  );
  router.post('/tabs/:id/select', async (c) => c.json(await service.selectTab(c.req.param('id'))));
  router.post('/navigate', async (c) => {
    const { url } = z.object({ url: z.string().url() }).strict().parse(readJsonBody(c));
    return c.json(await service.navigate(url));
  });
  router.post('/pause', async (c) => c.json(await service.pause()));
  router.post('/resume', async (c) => c.json(await service.resume()));
  router.post('/disconnect', async (c) => c.json(await service.disconnect()));
  return router;
}
