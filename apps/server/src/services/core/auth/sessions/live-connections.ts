/**
 * Signing out ends what that sign-in had open (F4 part 2, DOR-2969).
 *
 * A session cookie is checked once, when a stream or socket opens. Without
 * this, an event stream, a durable-stream WebSocket or a terminal opened by a
 * sign-in kept running after that sign-in was revoked, because nothing reads
 * the cookie again. So everything long-lived a person's cookie session holds
 * open registers here under that session, and ending the session closes it.
 *
 * - **Who registers.** `streamToNodeResponse` (every event stream and streamed
 *   download on the chain), the upgrade router (every credential-gated
 *   WebSocket), `POST /mcp` and the A2A JSON-RPC routes (a streamed answer,
 *   `message/stream` included) and `POST /api/terminal` (the PTY its
 *   bearer-of-id socket attaches to). Only for a cookie credential: an API key
 *   and a gate that asked for nothing name no session.
 * - **Not covered.** The workbench preview listener (its own port, reached by
 *   a signed token, not the cookie) and the extension bridge (an extension's
 *   own Express routes behind `/api/ext`, which may stream): neither registers,
 *   so either can outlive a sign-out until it ends by itself.
 * - **Who closes.** The session-delete hook in `../index.ts`, which Better
 *   Auth 1.7.6 fires once per row for every way it deletes one (sign-out,
 *   revoke-session, revoke-sessions, revoke-other-sessions, a password reset
 *   that revokes, and the devices routes). A delete outside this process (the
 *   CLI's `dorkos auth reset-password`, which writes the database directly)
 *   fires nothing here, so {@link sweepLiveConnections} asks the store every
 *   {@link LIVE_CONNECTION_SWEEP_MS} which registered sessions still exist,
 *   and closes the rest. A session that simply expires is closed by that sweep
 *   too, not at the instant it expires.
 * - **Recently ended.** Better Auth's signed cookie snapshot can answer for a
 *   deleted session for up to its cache age, so a closed stream could
 *   reconnect at once. {@link noteSessionEnded} remembers an ended session for
 *   that long, and the gate refuses it (`verifyRequestAuth`).
 * - **After a restart.** The ended-session memory starts empty, so for
 *   {@link ENDED_SESSION_MEMORY_MS} after this process starts the gate skips
 *   the cookie cache altogether ({@link inRestartWindow}): a sign-in ended
 *   just before the restart cannot ride its cached copy.
 * - **Bounded.** At most {@link MAX_LIVE_PER_SESSION} per session: past that,
 *   the oldest stream is closed, never silently forgotten, and never a
 *   terminal or a turn, which hold a person's work: a terminal is capped by
 *   its own manager, and a turn is one per chat.
 *   A close never throws out of here.
 *
 * In memory: a restart closes every stream anyway.
 *
 * @module services/core/auth/sessions/live-connections
 */
import { logger } from '../../../../lib/logger.js';

/** Most live things one sign-in may hold open; the oldest closes past it. */
export const MAX_LIVE_PER_SESSION = 128;

/** How often registered sessions are checked against the store. */
export const LIVE_CONNECTION_SWEEP_MS = 30_000;

/** How long an ended session is remembered: Better Auth's cookie cache age. */
export const ENDED_SESSION_MEMORY_MS = 5 * 60 * 1000;

/** Most ended sessions remembered at once; the oldest is forgotten past it. */
const MAX_ENDED_REMEMBERED = 10_000;

/**
 * What a registration is: a `stream` (an event stream, a socket, a streamed
 * response), which a client reopens when it drops, a `terminal`, which holds a
 * shell and its work, or a `turn`, a chat turn the sign-in started
 * (`./signed-in-turns.ts`).
 */
export type LiveConnectionKind = 'stream' | 'terminal' | 'turn';

/** One live thing a sign-in holds open. */
interface LiveEntry {
  readonly userId: string;
  readonly kind: LiveConnectionKind;
  readonly close: () => void;
}

/** When this process started, for {@link inRestartWindow}. */
let startedAt = Date.now();

/**
 * Whether this process started too recently to know every sign-in that ended
 * before it: until the cookie cache could have expired, the gate reads each
 * session from the store.
 *
 * @param now - The current time, for tests.
 * @param start - When the process started, for tests.
 */
export function inRestartWindow(now = Date.now(), start = startedAt): boolean {
  return now - start < ENDED_SESSION_MEMORY_MS;
}

/** Live things per session id, oldest first. */
const bySession = new Map<string, Map<symbol, LiveEntry>>();

/** Ended session ids, and until when each is refused. Oldest first. */
const ended = new Map<string, number>();

/** Run one close, never letting it throw. */
function runClose(entry: LiveEntry, sessionId: string): void {
  try {
    entry.close();
  } catch (error) {
    logger.warn('[Auth] Closing a signed-out connection failed', {
      sessionId,
      userId: entry.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Register one live thing a cookie session holds open.
 *
 * Past {@link MAX_LIVE_PER_SESSION}, the oldest stream closes to make room
 * (the new one, when it is the only stream). A terminal is never closed for
 * room: when only terminals and turns are left, the bound is let go, since the
 * terminal manager caps the one and each chat holds at most one of the other.
 *
 * @param sessionId - The Better Auth session id (never the token).
 * @param userId - The signed-in person.
 * @param close - Ends it. Called at most once.
 * @param kind - What it is; see {@link LiveConnectionKind}.
 * @returns Unregister, for when it ends by itself. Safe to call twice.
 */
export function registerLiveConnection(
  sessionId: string,
  userId: string,
  close: () => void,
  kind: LiveConnectionKind = 'stream'
): () => void {
  const key = Symbol(sessionId);
  let entries = bySession.get(sessionId);
  if (!entries) {
    entries = new Map();
    bySession.set(sessionId, entries);
  }
  entries.set(key, { userId, kind, close });
  if (entries.size > MAX_LIVE_PER_SESSION) {
    const oldestStream = [...entries].find(([, entry]) => entry.kind === 'stream');
    if (oldestStream) {
      entries.delete(oldestStream[0]);
      runClose(oldestStream[1], sessionId);
    }
  }
  return () => {
    const current = bySession.get(sessionId);
    if (!current?.delete(key)) return;
    if (current.size === 0) bySession.delete(sessionId);
  };
}

/**
 * Close everything one session holds open.
 *
 * @param sessionId - The session that ended.
 * @returns How many were closed.
 */
export function closeForSession(sessionId: string): number {
  const entries = bySession.get(sessionId);
  if (!entries) return 0;
  bySession.delete(sessionId);
  for (const entry of entries.values()) runClose(entry, sessionId);
  return entries.size;
}

/**
 * Remember that a session ended, so a cached cookie snapshot of it is refused
 * until that snapshot would have expired anyway.
 *
 * @param sessionId - The session that ended.
 * @param now - The current time, for tests.
 */
export function noteSessionEnded(sessionId: string, now = Date.now()): void {
  ended.delete(sessionId);
  ended.set(sessionId, now + ENDED_SESSION_MEMORY_MS);
  if (ended.size > MAX_ENDED_REMEMBERED) ended.delete(ended.keys().next().value!);
}

/**
 * Whether a session ended recently enough that a cached snapshot may still
 * vouch for it.
 *
 * @param sessionId - The session a cookie names.
 * @param now - The current time, for tests.
 */
export function sessionRecentlyEnded(sessionId: string, now = Date.now()): boolean {
  const until = ended.get(sessionId);
  if (until === undefined) return false;
  if (until > now) return true;
  ended.delete(sessionId);
  return false;
}

/**
 * A session row was deleted: remember it ended, and close what it held open.
 *
 * @param sessionId - The deleted session's id.
 */
export function endSession(sessionId: string): void {
  noteSessionEnded(sessionId);
  closeForSession(sessionId);
}

/** The session ids that hold something open now. */
function registeredSessionIds(): string[] {
  return [...bySession.keys()];
}

/**
 * Close what sessions ended elsewhere still hold open: every registered
 * session the store no longer knows as live. A store that cannot answer
 * closes nothing.
 *
 * @param liveIds - Which of the given session ids still exist unexpired.
 * @returns How many sessions were ended.
 */
export async function sweepLiveConnections(
  liveIds: (ids: readonly string[]) => Promise<ReadonlySet<string>>
): Promise<number> {
  const ids = registeredSessionIds();
  if (ids.length === 0) return 0;
  let live: ReadonlySet<string>;
  try {
    live = await liveIds(ids);
  } catch (error) {
    logger.warn('[Auth] Could not check which sign-ins are still live', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
  const gone = ids.filter((id) => !live.has(id));
  for (const id of gone) endSession(id);
  return gone.length;
}

/**
 * Start the sweep on a timer that never holds the process open.
 *
 * @param liveIds - See {@link sweepLiveConnections}.
 * @returns Stop.
 */
export function startLiveConnectionSweep(
  liveIds: (ids: readonly string[]) => Promise<ReadonlySet<string>>
): () => void {
  const timer = setInterval(() => void sweepLiveConnections(liveIds), LIVE_CONNECTION_SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Forget every registration and ended session.
 *
 * @internal Tests only.
 */
export function resetLiveConnectionsForTests(): void {
  bySession.clear();
  ended.clear();
}

/**
 * Act as a process that started long enough ago to trust the cookie cache,
 * for tests of the cache itself.
 *
 * @internal Tests only.
 */
export function endRestartWindowForTests(): void {
  startedAt = Date.now() - ENDED_SESSION_MEMORY_MS;
}
