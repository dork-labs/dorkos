/**
 * How a refusal from the rooms domain becomes an HTTP response
 * (spec `rooms`, ADR 260726-170125).
 *
 * Its own module because TWO routers answer for room state and both must refuse
 * the same way: `routes/rooms.ts` and, for `kind: 'room'`, the read-state route
 * `routes/read-cursors.ts`, which delegates its room writes into `RoomService`
 * and therefore inherits every way that service can say no. A second copy of
 * this table would drift the day a code is added, and the drift would show up as
 * one route answering 404 where the other answers 500 for the same request.
 *
 * @module routes/room-error-response
 */
import type { Response } from 'express';
import { RoomError, type RoomErrorCode } from '../services/rooms/index.js';
import { logger } from '../lib/logger.js';

/** HTTP status for each way the room service can refuse. */
export const STATUS_BY_CODE: Record<RoomErrorCode, number> = {
  ROOM_NOT_FOUND: 404,
  ENTRY_NOT_FOUND: 404,
  MEMBER_NOT_FOUND: 404,
  AGENT_NOT_FOUND: 404,
  SLUG_TAKEN: 409,
  INVALID_SLUG: 400,
  HANDLE_TAKEN: 409,
  HANDLE_RESERVED: 409,
  INVALID_HANDLE: 400,
  NESTED_THREAD: 400,
  // A 500 for the same reason `RESERVED_NATURAL_KEY` is one: no request can
  // carry a moment, so this code reaching a route means a detector built one
  // wrong rather than that somebody asked for something impossible.
  INVALID_MOMENT: 500,
  ROOM_ARCHIVED: 409,
  SYSTEM_ROOM: 403,
  OPERATOR_ONLY: 403,
  // A 403 even though the caller is the owner: the request named a room shape
  // this install does not allow, and there is no credential that would change
  // the answer. The remedy is in the message, not in who asks.
  OWNER_MUST_BE_PRESENT: 403,
  PEOPLE_ONLY: 403,
  // `post_to_room` is an MCP verb with no HTTP route, so this code reaches a
  // response only if one is ever added; it is mapped because the table is total
  // by type, and 400 because a DM is the wrong room to ask this of.
  TOOL_POST_NOT_IN_DM: 400,
  // Same story: an MCP-only verb, mapped because the table is total by type. A
  // 409 rather than a 400 — the request is well formed and the room is right,
  // but somebody stopped this turn while it was being written.
  TURN_WAS_STOPPED: 409,
  // This one IS reachable over HTTP today, and the comment above it used to say
  // otherwise: `POST /api/rooms/:id/entries/:entryId/reactions` resolves an
  // agent from `X-DorkOS-Agent` and goes through the same `toggleReaction`, so
  // an agent that has spent its hour gets this from the route as readily as from
  // the tool. The canonical 429.
  REACTION_RATE_LIMITED: 429,
  // A 401 rather than a 403: the caller presented nothing this surface could
  // resolve, so a credential IS what would change the answer. It belongs to the
  // capability surfaces, where "nobody" is a real answer; the room routes reach
  // 401 by the neighbouring code instead.
  UNIDENTIFIED_CALLER: 401,
  // The same reasoning, for a caller that presented a credential rather than
  // none: a token this machine could not verify. `resolveCaller` throws it
  // before any room is read, so it is the first thing every room route can
  // answer (DOR-1361).
  AGENT_IDENTITY_UNVERIFIED: 401,
  BROADCAST_NOT_BRIDGEABLE: 400,
  CHAT_ALREADY_BRIDGED: 409,
  BRIDGE_SECOND_AGENT_REFUSED: 409,
  UNKNOWN_CHAT_TYPE: 400,
  EXTERNAL_IDENTITY_INVALID: 400,
  // A 500, and deliberately not a 4xx: no HTTP caller can name a natural key,
  // so this code reaching a route means DorkOS built one wrong, not that a
  // request was bad.
  RESERVED_NATURAL_KEY: 500,
  NOT_A_BRIDGED_ROOM: 409,
  NO_SURVIVING_BRIDGE: 409,
  ATTACHMENT_NOT_FOUND: 404,
  ATTACHMENT_ALREADY_POSTED: 409,
  TOO_MANY_ATTACHMENTS: 400,
  // A 409 for both room-repo refusals: the request is well formed and the room
  // is right, but the install (or the room's own unmerged work) says not now.
  ROOM_REPOS_DISABLED: 409,
  ROOM_REPO_UNMERGED_WORK: 409,
  // A 409 rather than a 500: the request was well formed and nothing is broken.
  // This machine is missing a program, and installing it changes the answer.
  ROOM_REPO_GIT_UNAVAILABLE: 409,
};

/**
 * Map a thrown value onto a response. A {@link RoomError} carries its own code;
 * anything else is a bug and gets a generic 500 with the detail in the log, not
 * on the wire.
 *
 * @param res - The response to write to.
 * @param err - The caught value.
 * @param context - Route label for the log line.
 */
export function sendRoomError(res: Response, err: unknown, context: string): void {
  if (err instanceof RoomError) {
    res.status(STATUS_BY_CODE[err.code]).json({ error: err.message, code: err.code });
    return;
  }
  logger.error(`[rooms] ${context} failed`, { err });
  res.status(500).json({ error: 'Internal server error' });
}
