/**
 * `GET /api/sessions/running`: every chat with a live turn, per agent
 * (DOR-3460). Mounted ahead of the session routes, whose `/:id` would otherwise
 * answer it. An agent caller gets its allowed view, the same as `running_chats`.
 *
 * @module routes/running-chats
 */
import { Hono } from 'hono';
import type { RunningChatsResponse } from '@dorkos/shared/running-chats';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { listRunningChats } from '../services/session/running-chats/running-chats.js';
import { readerOfRequest } from './audit-reader.js';
import type { SessionRouteDeps } from './sessions.js';

/**
 * Build the route.
 *
 * @param deps - The session routes' deps, for the agent registry.
 */
export function createRunningChatsRoutes(deps: Pick<SessionRouteDeps, 'meshCore'>) {
  const router = new Hono<ApiEnv>();
  router.get('/', async (c) =>
    c.json(
      (await listRunningChats(
        deps.meshCore,
        readerOfRequest(honoRequestFacts(c))
      )) satisfies RunningChatsResponse
    )
  );
  return router;
}
