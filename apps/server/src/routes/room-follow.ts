/**
 * Following somebody's browser inside a room — three thin handlers over
 * {@link RoomFollowService} (spec `canvas-agent-seat` §6).
 *
 * **Mounted under the rooms router**, so `:id` is the room and every route here
 * inherits that file's caller resolution: an agent presenting a valid
 * `X-DorkOS-Agent` acts as itself, one presenting a token this machine cannot
 * verify is refused, and anyone else acts as the install's owner. A caller never
 * sends a follower.
 *
 * **People only, both ends.** An agent has no viewport to share and nothing to
 * follow with, so an agent caller is refused 403 `PEOPLE_ONLY` before anything
 * is read, and a claim naming an agent is refused by the service. The rule is
 * here and not only in the app, so a hand-written request is refused too.
 *
 * **Membership is the gate**, the same one the room's stream uses: an unknown
 * room and a room the caller is not in answer identically, so a room id is never
 * a capability.
 *
 * @module routes/room-follow
 */
import { Hono, type Context } from 'hono';
import {
  FollowRoomMemberRequestSchema,
  PublishRoomViewRequestSchema,
} from '@dorkos/shared/room-schemas';
import { getRoomService, RoomError } from '../services/rooms/index.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { parseOrRefuse, roomRoute, type RoomCaller } from './room-route.js';

/**
 * Mounted at `/:id/follow` by the rooms router, so `:id` — the ROOM — is a
 * parameter of every route here.
 */
const router = new Hono<ApiEnv>();

/**
 * The room this request is about: the `:id` the rooms router mounts this group
 * under.
 *
 * @param c - The Hono context.
 */
function roomOf(c: Context<ApiEnv>): string {
  return c.req.param('id')!;
}

/**
 * Refuse anybody who is not a person, BEFORE any room state is touched.
 *
 * The order matters for the same reason it does on the canvas routes:
 * `resolveCaller` answers for any authenticated caller, so a handler that acted
 * first and gated afterwards would have already published a frame by the time it
 * decided whether the caller was allowed to.
 *
 * @param caller - The request's caller, resolved here.
 * @returns The caller's author id.
 * @throws {RoomError} `PEOPLE_ONLY` when an agent is calling.
 */
function requirePersonCaller(caller: RoomCaller): string {
  const author = caller();
  if (author.kind !== 'human') {
    throw new RoomError('PEOPLE_ONLY', 'Only a person can follow somebody, or be followed.');
  }
  return author.id;
}

/**
 * PUT / — start following somebody here, or say you are still following them.
 *
 * Idempotent, and deliberately a refresh rather than a subscription: the app
 * calls it on a beat, and a claim nobody restates lapses on its own. That is
 * what makes a closed tab, a crashed browser and a lost network the same event.
 */
router.put('/', (c) => {
  const body = parseOrRefuse(c, FollowRoomMemberRequestSchema, readJsonBody(c));
  if (body instanceof Response) return body;
  return roomRoute(c, 'PUT /:id/follow', (caller) => {
    getRoomService().follow.follow(roomOf(c), requirePersonCaller(caller), body.memberId);
    return c.body(null, 204);
  });
});

/**
 * DELETE / — stop following whoever you were following here.
 *
 * Answers 204 whether or not there was a claim to drop: pressing the toggle off
 * twice is not an error, and a page unloading after its claim already lapsed
 * should not be told off.
 */
router.delete('/', (c) =>
  roomRoute(c, 'DELETE /:id/follow', (caller) => {
    getRoomService().follow.unfollow(roomOf(c), requirePersonCaller(caller));
    return c.body(null, 204);
  })
);

/**
 * POST /view — say where you are looking, for whoever is following you.
 *
 * The answer says whether anybody was: `false` means the caller should stop
 * sending, which is how a client that missed the "nobody is following you any
 * more" frame goes quiet on its own.
 */
router.post('/view', (c) => {
  const body = parseOrRefuse(c, PublishRoomViewRequestSchema, readJsonBody(c));
  if (body instanceof Response) return body;
  return roomRoute(c, 'POST /:id/follow/view', (caller) => {
    const followed = getRoomService().follow.publishView(
      roomOf(c),
      requirePersonCaller(caller),
      body
    );
    return c.json({ followed });
  });
});

export default router;
