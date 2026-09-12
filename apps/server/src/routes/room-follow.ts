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
import { Router, type Request, type Response } from 'express';
import {
  FollowRoomMemberRequestSchema,
  PublishRoomViewRequestSchema,
} from '@dorkos/shared/room-schemas';
import { getRoomService, RoomError } from '../services/rooms/index.js';
import { resolveCaller } from './room-caller.js';
import { sendRoomError } from './room-error-response.js';
import { parseBody } from '../lib/route-utils.js';

/**
 * `mergeParams` so `:id` — the ROOM, owned by the router this one is mounted
 * under — is readable here.
 */
const router = Router({ mergeParams: true });

/** What a handler here reads off the path: the room it is mounted under. */
interface FollowParams {
  /** The room. Owned by the rooms router. */
  id: string;
}

/**
 * Refuse anybody who is not a person, BEFORE any room state is touched.
 *
 * The order matters for the same reason it does on the canvas routes:
 * `resolveCaller` answers for any authenticated caller, so a handler that acted
 * first and gated afterwards would have already published a frame by the time it
 * decided whether the caller was allowed to.
 *
 * @param req - The request, for its caller.
 * @param res - The response, for `resolveCaller`.
 * @returns The caller's author id.
 * @throws {RoomError} `PEOPLE_ONLY` when an agent is calling.
 */
function requirePersonCaller(req: Request<FollowParams>, res: Response): string {
  const caller = resolveCaller(req, res);
  if (caller.kind !== 'human') {
    throw new RoomError('PEOPLE_ONLY', 'Only a person can follow somebody, or be followed.');
  }
  return caller.id;
}

/**
 * PUT / — start following somebody here, or say you are still following them.
 *
 * Idempotent, and deliberately a refresh rather than a subscription: the app
 * calls it on a beat, and a claim nobody restates lapses on its own. That is
 * what makes a closed tab, a crashed browser and a lost network the same event.
 */
router.put<FollowParams>('/', (req, res) => {
  const body = parseBody(FollowRoomMemberRequestSchema, req.body, res);
  if (!body) return;
  try {
    const caller = requirePersonCaller(req, res);
    getRoomService().follow.follow(req.params.id, caller, body.memberId);
    res.status(204).end();
  } catch (err) {
    sendRoomError(res, err, 'PUT /:id/follow');
  }
});

/**
 * DELETE / — stop following whoever you were following here.
 *
 * Answers 204 whether or not there was a claim to drop: pressing the toggle off
 * twice is not an error, and a page unloading after its claim already lapsed
 * should not be told off.
 */
router.delete<FollowParams>('/', (req, res) => {
  try {
    const caller = requirePersonCaller(req, res);
    getRoomService().follow.unfollow(req.params.id, caller);
    res.status(204).end();
  } catch (err) {
    sendRoomError(res, err, 'DELETE /:id/follow');
  }
});

/**
 * POST /view — say where you are looking, for whoever is following you.
 *
 * The answer says whether anybody was: `false` means the caller should stop
 * sending, which is how a client that missed the "nobody is following you any
 * more" frame goes quiet on its own.
 */
router.post<FollowParams>('/view', (req, res) => {
  const body = parseBody(PublishRoomViewRequestSchema, req.body, res);
  if (!body) return;
  try {
    const caller = requirePersonCaller(req, res);
    const followed = getRoomService().follow.publishView(req.params.id, caller, body);
    res.json({ followed });
  } catch (err) {
    sendRoomError(res, err, 'POST /:id/follow/view');
  }
});

export default router;
