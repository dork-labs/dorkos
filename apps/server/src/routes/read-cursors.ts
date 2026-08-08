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
import { Router } from 'express';
import {
  ReadCursorParamsSchema,
  SetReadCursorPositionRequestSchema,
} from '@dorkos/shared/read-cursor-schemas';
import { parseBody, sendError } from '../lib/route-utils.js';
import { getReadCursorService } from '../services/core/read-cursor-service.js';
import { resolveCaller } from './room-caller.js';

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
 * The person check is on the RESOLVED author's `kind` rather than on the
 * presence of an `X-DorkOS-Agent` header. Those are the same test today, and
 * the header is the narrower one: if `resolveCaller` ever grows a fourth
 * branch, asking what the caller turned out to BE keeps holding, while asking
 * how it authenticated quietly stops.
 */
router.put('/:kind/:id', (req, res) => {
  const params = parseBody(ReadCursorParamsSchema, req.params, res);
  if (!params) return;
  const body = parseBody(SetReadCursorPositionRequestSchema, req.body, res);
  if (!body) return;

  const caller = resolveCaller(res);
  if (caller.kind !== 'human') {
    // 403 rather than 404: there is nothing to hide here, and telling an agent
    // "this is not yours to write" is more useful than pretending the route
    // does not exist.
    sendError(res, 403, 'Only people have read state', 'PEOPLE_ONLY');
    return;
  }

  res.json(getReadCursorService().advance(caller.id, params.kind, params.id, body.lastReadSeq));
});

export default router;
