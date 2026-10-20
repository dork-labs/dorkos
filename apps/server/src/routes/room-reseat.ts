/**
 * Moving an agent's seat in a room or DM to another account (Re-seat P0): the
 * "Continue on another account…" picker's two calls. Thin handlers over the
 * room service, which holds the rule: only a person may move a seat for now
 * (Security Must 5), and the move is the same one the automatic path makes.
 *
 * - `GET  /api/rooms/:id/members/:authorId/reseat-options` → {@link ReseatOptions}
 * - `POST /api/rooms/:id/members/:authorId/reseat` `{ account? }` → `{ sessionId }`
 *
 * **Mounted under the rooms router**, so `:id` is the room and every route here
 * inherits its caller resolution and its refusals.
 *
 * @module routes/room-reseat
 */
import { Hono } from 'hono';
import { ReseatSeatRequestSchema, type ReseatOptions } from '@dorkos/shared/room-schemas';
import { getRoomService } from '../services/rooms/index.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { parseOrRefuse, roomRoute } from './room-route.js';

/** Mounted at `/:id/members/:authorId` by the rooms router. */
const router = new Hono<ApiEnv>();

router.get('/reseat-options', (c) =>
  roomRoute(c, 'GET /:id/members/:authorId/reseat-options', async (caller) => {
    const options: ReseatOptions = await getRoomService().reseatOptions(
      c.req.param('id')!,
      c.req.param('authorId')!,
      caller().id
    );
    return c.json(options);
  })
);

router.post('/reseat', (c) => {
  const body = parseOrRefuse(c, ReseatSeatRequestSchema, readJsonBody(c) ?? {});
  if (body instanceof Response) return body;
  return roomRoute(c, 'POST /:id/members/:authorId/reseat', async (caller) =>
    c.json(
      await getRoomService().reseatAgent(
        c.req.param('id')!,
        c.req.param('authorId')!,
        caller().id,
        {
          ...(body.account !== undefined ? { accountId: body.account } : {}),
        }
      )
    )
  );
});

export default router;
