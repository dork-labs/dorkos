/**
 * Read state HTTP API (team-room-home spec §D4) — one route for every kind of
 * thread a person reads.
 *
 * Its own router rather than more surface on `rooms.ts`, because a read cursor
 * is not a room concept: the same table answers for rooms, agent sessions and
 * the inbox, and only one of those three is a room. Hanging it off `/api/rooms`
 * would have made a session's cursor a room endpoint forever.
 *
 * **The cursor written is always the caller's.** `resolveCaller` decides who
 * that is — the same resolution the room routes use, and for the same reason:
 * identity read from a path or a body would let any client move (and therefore
 * read back) anyone else's read state. There is deliberately no way to name a
 * user in this request.
 *
 * **And only people have read state here.** `read_cursors` is the user-side
 * store by contract (ADR 260808-140956); what an AGENT has been shown is
 * `room_members.last_read_seq`, which survives and is written by the ambient
 * participation loop, never by this route. So a caller the server resolves as
 * an agent is refused rather than quietly given a row of its own — the same
 * boundary reacting draws, with the same `PEOPLE_ONLY` code.
 *
 * @module routes/read-cursors
 */
import { Router, type Request, type Response } from 'express';
import {
  ReadCursorParamsSchema,
  SetReadCursorPositionRequestSchema,
  type ReadCursorResponse,
} from '@dorkos/shared/read-cursor-schemas';
import { parseBody, sendError } from '../lib/route-utils.js';
import { getReadCursorService } from '../services/core/read-cursor-service.js';
import {
  getRoomService,
  getWelcomeBackGreeter,
  type AuthorRecord,
} from '../services/rooms/index.js';
import { resolveCaller } from './room-caller.js';
import { sendRoomError } from './room-error-response.js';

const router = Router();

/**
 * PUT /:kind/:id — advance the caller's cursor in one thread.
 *
 * Both segments are validated: an unrecognised `kind` is a 400 rather than a
 * row nothing will ever read back, since the table's own `CHECK` would take it
 * as a hard failure much later and much further from the caller.
 *
 * Express 5 leaves `req.body` undefined on a bodiless PUT, which the object
 * schema refuses — so an empty request answers 400 rather than throwing on a
 * destructure.
 *
 * **Whether the thread exists, and whether the caller may see it, is the
 * addressed domain's business — and a domain that HAS an answer is asked.**
 * `kind: 'room'` delegates the whole write into `RoomService.setReadCursor`, so
 * a room cursor moved through here is the same call the room's own route makes:
 * the same `requireVisibleRoom`, the same monotonic guard, the same broadcast
 * carrying the unread count the sidebar draws. Anything else lands straight on
 * the table. That is not a shortcut for rooms — it is the difference between
 * one write path and two, and the failure it prevents is specific: a
 * cursor written here without the room's count is an event the room list has
 * nothing to patch with, so the badge on the second device stays lit.
 *
 * A session and an inbox item carry no such check because there is nothing to
 * check against — session storage is runtime-owned (ADR-0310), a cursor
 * outlives the thread it points into, and `thread_id` therefore carries no
 * foreign key. What that costs is bounded by what a cursor is: a number a
 * client stores about itself, inert until that same client reads it back.
 *
 * **Two refusals, because "not a person" is two different facts.** A caller
 * presenting an `X-DorkOS-Agent` token this machine cannot verify is refused
 * 401 by `resolveCaller` before this router sees it — the WIDER question, since
 * a revoked or expired agent is still an agent and used to fall through to the
 * operator (DOR-1361). Past that, the check is on the RESOLVED author's `kind`,
 * which is the narrower question and the right one to ask second: if
 * `resolveCaller` ever grows a fifth branch, asking what the caller turned out
 * to BE keeps holding, while asking how it authenticated quietly stops.
 * {@link personOrRefuse} is where both live.
 */
router.put('/:kind/:id', (req, res) => {
  const params = parseBody(ReadCursorParamsSchema, req.params, res);
  if (!params) return;
  const body = parseBody(SetReadCursorPositionRequestSchema, req.body, res);
  if (!body) return;

  const caller = personOrRefuse(req, res);
  if (!caller) return;

  // Somebody is at the keyboard, and this request is the proof: a client only
  // marks a thread read because a person is looking at it. Told BEFORE the
  // write, because coming back is measured from the last thing this person did
  // and the line below is about to become that thing (team-room-home §D5.2).
  // Never throws and never waits — a greeting must not be able to fail a read.
  getWelcomeBackGreeter()?.personSeen(caller.id);

  if (params.kind === 'room') {
    try {
      getRoomService().setReadCursor(params.id, caller.id, body.lastReadSeq);
    } catch (err) {
      // The rooms domain's own mapping, shared rather than mirrored: a caller
      // who is not in the room gets the 404 the room route gives them, not a
      // 500 from a router that had no opinion.
      sendRoomError(res, err, 'PUT /read-cursors/room/:id');
      return;
    }
    // Read back rather than returned by the delegation, because the room
    // service answers in the ROOM's vocabulary (a membership) and this route
    // promises a cursor. Non-null by construction: the call above wrote this
    // exact row for this exact person — agents were refused several lines up.
    const cursor = getReadCursorService().get(caller.id, 'room', params.id);
    if (!cursor) throw new Error('a room read cursor vanished as it was written');
    res.json(cursor);
    return;
  }

  res.json(getReadCursorService().advance(caller.id, params.kind, params.id, body.lastReadSeq));
});

/**
 * GET /:kind/:id — where the caller left off in one thread.
 *
 * The read half of the PUT above, and it answers `{ cursor: null }` rather than
 * a 404 for a thread this person has never read: never-read is the state every
 * thread starts in, and a client that has to treat the ordinary case as an error
 * ends up treating a real failure as ordinary too.
 *
 * Same caller resolution, same refusal for agents, and the same absence of any
 * way to name a user — a cursor is only ever read back by whoever wrote it.
 */
router.get('/:kind/:id', (req, res) => {
  const params = parseBody(ReadCursorParamsSchema, req.params, res);
  if (!params) return;

  const caller = personOrRefuse(req, res);
  if (!caller) return;

  const cursor = getReadCursorService().get(caller.id, params.kind, params.id);
  const body: ReadCursorResponse = { cursor };
  res.json(body);
});

/**
 * The person this request is, or `null` after answering the refusal it earns.
 *
 * Two refusals, and they are different facts about the caller:
 *
 * - **401 `AGENT_IDENTITY_UNVERIFIED`**, thrown by `resolveCaller` when the
 *   caller presented an agent token this machine could not verify. Answered
 *   through `sendRoomError` so it reads identically here and on the room routes
 *   — a caller that cannot be named is not a caller with no read state, it is a
 *   caller with a credential problem (DOR-1361).
 * - **403 `PEOPLE_ONLY`** for an agent that IS named. A 403 rather than a 404:
 *   there is nothing to hide here, and telling an agent "this is not yours to
 *   write" is more useful than pretending the route does not exist.
 *
 * @param req - The incoming request, for the raw agent header.
 * @param res - The response, for the resolved identity and the refusal.
 */
function personOrRefuse(req: Request, res: Response): AuthorRecord | null {
  let caller: AuthorRecord;
  try {
    caller = resolveCaller(req, res);
  } catch (err) {
    sendRoomError(res, err, 'read-cursors');
    return null;
  }
  if (caller.kind !== 'human') {
    sendError(res, 403, 'Only people have read state', 'PEOPLE_ONLY');
    return null;
  }
  return caller;
}

export default router;
