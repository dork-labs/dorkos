import { DocumentFileSaveCloseBlockedError } from '../services/canvas/doc-channel/writes/file-save-lifecycle/close-guard.js';
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
import {
  isOwnerRecord,
  RoomError,
  roomRefusalFor,
  type AuthorRecord,
  type RoomErrorCode,
} from '../services/rooms/index.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import { logger } from '../lib/logger.js';
import { problemBody, sendProblem, type ProblemStatus } from '@dorkos/http-kit';
import { PROBLEM_CODES, type Problem, type ProblemCode } from '@dorkos/shared/problem';
import type { Context } from 'hono';

/**
 * The problem a room refusal is answered with over HTTP: its code, and its
 * status when the code's default is not it.
 */
export interface RoomProblem {
  /** The problem code the response carries. */
  code: ProblemCode;
  /** The status, when it differs from the code's default. */
  status?: ProblemStatus;
}

/**
 * The HTTP answer for each way the room service can refuse (DOR-4979).
 *
 * `RoomErrorCode` stays the domain's own vocabulary, read by the MCP tools and
 * the capability answers; this table is only its projection onto the API. A
 * code a client branches on keeps a code of its own; every other one becomes
 * the generic code of the same meaning. Total by type, so a new room code
 * cannot reach a response without one.
 */
export const PROBLEM_BY_CODE: Record<RoomErrorCode, RoomProblem> = {
  ROOM_NOT_FOUND: { code: 'room_not_found' },
  ENTRY_NOT_FOUND: { code: 'not_found' },
  MEMBER_NOT_FOUND: { code: 'not_found' },
  AGENT_NOT_FOUND: { code: 'not_found' },
  COMMUNITY_OUTBOX_FULL: { code: 'rate_limited' },
  COMMUNITY_DELIVERY_UNAVAILABLE: { code: 'conflict' },
  SLUG_TAKEN: { code: 'slug_taken' },
  // A 409 beside `SLUG_TAKEN`, and for the identical reason: a room's name is
  // already somebody else's. A DM's name is who is in it, so this is what a
  // roster edit gets when it would make two conversations hold the same people.
  DM_MEMBER_SET_TAKEN: { code: 'conflict' },
  INVALID_SLUG: { code: 'invalid_request' },
  HANDLE_TAKEN: { code: 'handle_taken' },
  HANDLE_RESERVED: { code: 'handle_reserved' },
  HANDLE_LOOKALIKE: { code: 'handle_lookalike' },
  INVALID_HANDLE: { code: 'invalid_handle' },
  NESTED_THREAD: { code: 'invalid_request' },
  // A 500 for the same reason `RESERVED_NATURAL_KEY` is one: no request can
  // carry a moment, so this code reaching a route means a detector built one
  // wrong rather than that somebody asked for something impossible.
  INVALID_MOMENT: { code: 'internal_error' },
  ROOM_ARCHIVED: { code: 'room_archived' },
  SYSTEM_ROOM: { code: 'forbidden' },
  OPERATOR_ONLY: { code: 'operator_only' },
  PRIVATE_SPACE: { code: 'forbidden' },
  // A 403 even though the caller is the owner: the request named a room shape
  // this install does not allow, and there is no credential that would change
  // the answer. The remedy is in the message, not in who asks.
  OWNER_MUST_BE_PRESENT: { code: 'forbidden' },
  PEOPLE_ONLY: { code: 'person_only' },
  // Re-seat refusals: nothing is wrong with the request, the state is.
  NO_ACCOUNT_LEFT: { code: 'conflict' },
  AGENT_MAY_NOT_MOVE_YET: { code: 'conflict' },
  AGENT_WORKING: { code: 'conflict' },
  NOTHING_TO_MOVE: { code: 'conflict' },
  // `post_to_room` is an MCP verb with no HTTP route, so this code reaches a
  // response only if one is ever added; it is mapped because the table is total
  // by type, and 400 because a DM is the wrong room to ask this of.
  // The `leave_room` twin, and the same story again: an MCP-only verb, mapped
  // because the table is total by type. 400 for the same reason — a direct
  // message is the wrong kind of room to ask this of, and no retry fixes it.
  TOOL_LEAVE_NOT_IN_DM: { code: 'invalid_request' },
  TOOL_ARCHIVE_NOT_IN_DM: { code: 'invalid_request' },
  TOOL_ARCHIVE_BRIDGED: { code: 'invalid_request' },
  // The `update_room` twin, mapped for the same reason the two above are: the
  // table is total by type. 400 because a direct message is the wrong kind of
  // room to ask this of, and no retry fixes it.
  TOOL_RENAME_NOT_IN_DM: { code: 'invalid_request' },
  // A document this room's canvas does not hold. 404 beside `ENTRY_NOT_FOUND`,
  // and scoped to the room for the same reason: an id from elsewhere must not
  // answer differently from an id that never existed.
  CANVAS_DOCUMENT_NOT_FOUND: { code: 'not_found' },
  // Somebody is editing it. 409 rather than 403 — the request is allowed and the
  // document is right; it is the moment that is wrong, and it passes.
  CANVAS_BEING_EDITED: { code: 'conflict' },
  // A bare update or close from somebody with nothing of their own on the table.
  // 400: the request named no document and there is none to infer, which no
  // retry fixes without naming one.
  CANVAS_NO_DEFAULT_DOCUMENT: { code: 'invalid_request' },
  // A window action asked for inside a room. 400 because the action is real and
  // the room is the wrong surface for it; both MCP-only today, mapped because
  // this table is total by type.
  CANVAS_ACTION_NOT_AVAILABLE_IN_A_ROOM: { code: 'invalid_request' },
  // 400: a follow claim on yourself. The request is well formed and the room is
  // right; the two author ids are the same, and no retry changes that.
  CANNOT_FOLLOW_YOURSELF: { code: 'invalid_request' },
  // 429: this process already holds as many follow claims as it will. A retry
  // is exactly the right thing to do once some of them lapse.
  TOO_MANY_FOLLOWERS: { code: 'rate_limited' },
  // The writer faulted or is absent. 503, not 404: nothing was missing, the
  // server could not do it — and a retry is a reasonable thing for a caller to
  // do, which is the difference this code exists to state. The session-canvas
  // routes answer the same status from their own `CANVAS_UNAVAILABLE` check
  // before they reach the writer at all.
  CANVAS_UNAVAILABLE: { code: 'temporarily_unavailable' },
  // Same story: an MCP-only verb, mapped because the table is total by type. A
  // 409 rather than a 400 — the request is well formed and the room is right,
  // but somebody stopped this turn while it was being written.
  TURN_WAS_STOPPED: { code: 'conflict' },
  // A 401 rather than a 403: the caller presented nothing this surface could
  // resolve, so a credential IS what would change the answer. It belongs to the
  // capability surfaces, where "nobody" is a real answer; the room routes reach
  // 401 by the neighbouring code instead.
  UNIDENTIFIED_CALLER: { code: 'unauthenticated' },
  // The same reasoning, for a caller that presented a credential rather than
  // none: a token this machine could not verify. `resolveCaller` throws it
  // before any room is read, so it is the first thing every room route can
  // answer (DOR-1361).
  AGENT_IDENTITY_UNVERIFIED: { code: 'agent_identity_unverified' },
  // A write that only the owner's session could make theirs (DOR-3330).
  PERSON_SESSION_REQUIRED: { code: 'person_session_required' },
  BROADCAST_NOT_BRIDGEABLE: { code: 'broadcast_not_bridgeable' },
  CHAT_ALREADY_BRIDGED: { code: 'conflict' },
  BRIDGE_SECOND_AGENT_REFUSED: { code: 'conflict' },
  UNKNOWN_CHAT_TYPE: { code: 'invalid_request' },
  EXTERNAL_IDENTITY_INVALID: { code: 'invalid_request' },
  // A 500, and deliberately not a 4xx: no HTTP caller can name a natural key,
  // so this code reaching a route means DorkOS built one wrong, not that a
  // request was bad.
  RESERVED_NATURAL_KEY: { code: 'internal_error' },
  // A 400, unlike its neighbour above: a request CAN name an author id, so this
  // one really is somebody asking to claim a row that is not claimable.
  IDENTITY_NOT_EXTERNAL: { code: 'identity_not_external' },
  NOT_A_BRIDGED_ROOM: { code: 'conflict' },
  // A 400: the request named somebody who is not an agent member of this
  // channel, or asked a direct message for a lead.
  INVALID_LEAD: { code: 'invalid_request' },
  // A 400: the 👀 receipt is the room's own, so an agent's request for it is
  // malformed rather than refused for lack of a credential.
  RECEIPT_EMOJI_RESERVED: { code: 'invalid_request' },
  INVALID_REACTION: { code: 'invalid_request' },
  NO_SURVIVING_BRIDGE: { code: 'conflict' },
  ATTACHMENT_NOT_FOUND: { code: 'attachment_not_found' },
  ATTACHMENT_ALREADY_POSTED: { code: 'conflict' },
  TOO_MANY_ATTACHMENTS: { code: 'invalid_request' },
  // Agent file and canvas refusals. No route reaches them today, but the table
  // is exhaustive over the code union so a code without a status cannot exist.
  ATTACHMENT_PATH_REFUSED: { code: 'forbidden' },
  CANVAS_PROTECTED_FILE: { code: 'forbidden' },
  CANVAS_APP_WIDGET_ACTION: { code: 'invalid_request' },
  CANVAS_MEMBERS_CANT_READ: { code: 'forbidden' },
  ATTACHMENT_UNREADABLE: { code: 'invalid_request' },
  ATTACHMENT_TOO_LARGE: { code: 'request_too_large' },
  // A 409 for both room-repo refusals: the request is well formed and the room
  // is right, but the install (or the room's own unmerged work) says not now.
  ROOM_REPOS_DISABLED: { code: 'room_repos_disabled' },
  ROOM_REPO_UNMERGED_WORK: { code: 'conflict' },
  // A 409 rather than a 500: the request was well formed and nothing is broken.
  // This machine is missing a program, and installing it changes the answer.
  ROOM_REPO_GIT_UNAVAILABLE: { code: 'room_repo_git_unavailable' },
  // A 409 beside the other two room-repo states: the room is real, the caller
  // may see it, and there is simply nothing to read yet. Never a 404 — that
  // status is reserved for "no such room", which is also what a non-member
  // gets, and reusing it here would make the two indistinguishable in a log.
  ROOM_HAS_NO_REPO: { code: 'room_has_no_repo' },
  ROOM_FILE_PATH_INVALID: { code: 'room_file_path_invalid' },
  // A 404 about a PATH, not about a room. It is only reachable by a caller the
  // room has already admitted, so it discloses nothing a listing does not.
  ROOM_FILE_NOT_FOUND: { code: 'room_file_not_found' },
  // A 400: the path is real, but it is a folder, a link or another repository
  // and the request asked for something else. The message says which.
  ROOM_FILE_NOT_READABLE: { code: 'room_file_not_readable' },
  // A 400 for the same reason: the request carried bytes that would stop being
  // a text file, and no credential or retry changes that.
  ROOM_FILE_NOT_TEXT: { code: 'room_file_not_text' },
  // A 409: the request is well formed and allowed, and the room already holds
  // something at that path. What changes the answer is the person choosing to
  // replace it, or another name.
  ROOM_FILE_EXISTS: { code: 'room_file_exists' },
  // A 400: nothing about the room or the caller changes how many files one
  // upload may carry.
  ROOM_UPLOAD_TOO_MANY_FILES: { code: 'room_upload_too_many_files' },
  // The room exists and the caller may see it; it simply has no files. A 409
  // rather than a 404, for the same reason as the two above: the answer changes
  // by giving the room a repo, not by asking about a different room.
  NOT_A_PROJECT_ROOM: { code: 'conflict' },
  // Every merge refusal is a 409, and they are 409s for one shared reason: the
  // request is well formed, the caller is allowed, and the room said not yet.
  // What changes the answer is always an act in the caller's own tree — commit,
  // sync, shrink the file, wait — never a different request or a better
  // credential.
  UNCOMMITTED_WORK: { code: 'conflict' },
  BEHIND_MAIN: { code: 'conflict' },
  MAIN_CHECKOUT_DIRTY: { code: 'main_checkout_dirty' },
  ROOM_REPO_CONFIG_UNSAFE: { code: 'room_repo_config_unsafe' },
  SYMLINK_ESCAPES_REPO: { code: 'conflict' },
  FILE_TOO_LARGE: { code: 'file_too_large' },
  REPO_CAP_EXCEEDED: { code: 'repo_cap_exceeded' },
  MERGE_CONFLICT: { code: 'conflict' },
  NOTHING_TO_MERGE: { code: 'conflict' },
  SUBMODULE_NOT_ALLOWED: { code: 'conflict' },
  // The exception, and the canonical status for it: the caller waited its turn
  // and the room is still busy. A 429 says "ask again", which is exactly the
  // remedy.
  MERGE_IN_FLIGHT: { code: 'merge_in_flight' },
};

/**
 * The HTTP status a room refusal answers with.
 *
 * @param code - The room service's code.
 * @returns The status, for a surface that sends no body (a WebSocket upgrade).
 */
export function roomErrorStatus(code: RoomErrorCode): number {
  const mapped = PROBLEM_BY_CODE[code];
  return mapped.status ?? PROBLEM_CODES[mapped.code].status;
}

/**
 * Map a thrown value onto a problem document. A {@link RoomError} carries its
 * own code; anything else is a bug and gets a generic `internal_error` with
 * the detail in the log, not on the wire.
 *
 * @param err - The caught value.
 * @param context - Route label for the log line.
 * @param ownerAsking - Whether the caller is the install's owner; see
 *   {@link isOwnerCaller}.
 * @returns The problem.
 */
export function roomErrorProblem(
  err: unknown,
  context: string,
  ownerAsking: () => boolean
): Problem {
  if (err instanceof DocumentFileSaveCloseBlockedError) {
    // The room code is `CANVAS_UNAVAILABLE` for the agent tools; over HTTP it
    // is a conflict that names the recovery the client has to run.
    return problemBody('conflict', {
      detail: err.message,
      extensions: { recoveryCode: err.recoveryCode },
    });
  }
  if (err instanceof RoomError) {
    // Worded before a status is chosen, so nothing can leave a half-written reply.
    const refusal = roomRefusalFor(err, ownerAsking);
    const mapped = PROBLEM_BY_CODE[err.code];
    return problemBody(mapped.code, {
      detail: refusal.error,
      ...(mapped.status === undefined ? {} : { status: mapped.status }),
      ...(refusal.command === undefined ? {} : { extensions: { command: refusal.command } }),
    });
  }
  logger.error(`[rooms] ${context} failed`, { err });
  return problemBody('internal_error');
}

/**
 * Answer a thrown value as a room refusal: {@link roomErrorProblem}, sent.
 *
 * @param c - The Hono context.
 * @param err - The caught value.
 * @param context - Route label for the log line.
 * @param ownerAsking - Whether the caller is the install's owner.
 * @returns The response.
 */
export function sendRoomError(
  c: Context,
  err: unknown,
  context: string,
  ownerAsking: () => boolean
): Response {
  return sendProblem(c, roomErrorProblem(err, context, ownerAsking));
}

/**
 * Whether a resolved room caller is the install's owner; `false` for none.
 *
 * @param caller - The caller `resolveCaller` returned, if it returned one.
 */
export function isOwnerCaller(caller: AuthorRecord | undefined): boolean {
  return caller !== undefined && isOwnerRecord(caller, readOwnerAccount()?.id ?? null);
}
