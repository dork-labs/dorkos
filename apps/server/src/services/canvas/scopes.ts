/**
 * Who owns a canvas document — the scope string, and how to read one back
 * (spec `canvas-agent-seat` §1.1).
 *
 * One table serves two owners: a room's shared table and one person's session
 * canvas. The `scope` column is what tells them apart, it is what every index
 * and every query keys on, and these three functions are the only place its
 * spelling is decided.
 *
 * **A session scope names the CANONICAL session id.** A brand-new claude-code
 * session streams under the request UUID the client minted and is renamed to the
 * SDK's id mid-first-turn; {@link CanvasService.rekeyScope} moves every row
 * across that rename in one statement.
 *
 * @module server/services/canvas/scopes
 */

/** The prefix a room's documents live under. */
const ROOM_PREFIX = 'room:';

/** The prefix a session's documents live under. */
const SESSION_PREFIX = 'session:';

/** What a scope string turns out to name. */
export type CanvasScope =
  { kind: 'room'; id: string } | { kind: 'session'; id: string } | { kind: 'unknown'; id: null };

/**
 * The scope string one room's documents live under.
 *
 * @param roomId - The room.
 * @returns `room:<roomId>`.
 */
export function roomScope(roomId: string): string {
  return `${ROOM_PREFIX}${roomId}`;
}

/**
 * The scope string one session's documents live under.
 *
 * @param sessionId - The session, by its canonical id.
 * @returns `session:<sessionId>`.
 */
export function sessionScope(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}`;
}

/**
 * Read a scope string back into what it names.
 *
 * Answers `unknown` rather than throwing for anything else. A row written by a
 * future build carries whatever it carries, and one unreadable scope must
 * degrade to "not mine" rather than take a listing down — the same posture the
 * store takes with a content blob it cannot parse.
 *
 * @param scope - The stored scope string.
 * @returns What it names.
 */
export function parseScope(scope: string): CanvasScope {
  if (scope.startsWith(ROOM_PREFIX)) {
    const id = scope.slice(ROOM_PREFIX.length);
    if (id.length > 0) return { kind: 'room', id };
  }
  if (scope.startsWith(SESSION_PREFIX)) {
    const id = scope.slice(SESSION_PREFIX.length);
    if (id.length > 0) return { kind: 'session', id };
  }
  return { kind: 'unknown', id: null };
}

/**
 * The `room_id` column a row in this scope must carry.
 *
 * **The invariant, in one place.** A `room:` row's `room_id` equals its scope's
 * id, so the room's `ON DELETE cascade` reclaims it. A `session:` row's is
 * `null`, so an unrelated room deletion cannot take it — which is exactly the
 * bug a copied `room_id` would cause, and it would be invisible until somebody
 * deleted a room.
 *
 * @param scope - The scope the row belongs to.
 * @returns The room id to store, or `null`.
 */
export function roomIdForScope(scope: string): string | null {
  const parsed = parseScope(scope);
  return parsed.kind === 'room' ? parsed.id : null;
}

/**
 * Who a document on a SESSION canvas is attributed to when the person put it
 * there.
 *
 * A session has no roster, so it has no author ids to borrow — but it does have
 * two writers whose difference matters, and the edit lock is why: while the
 * person is typing in a document, the agent's push to it is HELD. One shared
 * author id would make the agent look like the lock holder and walk straight
 * over their draft.
 *
 * They are literal words rather than opaque ids because they reach the model in
 * `get_ui_state`, where "who put this here" has exactly two possible answers and
 * both should read as themselves.
 */
export const SESSION_OWNER_AUTHOR = 'owner';

/** Who a document is attributed to when the session's own agent put it there. */
export const SESSION_AGENT_AUTHOR = 'agent';
