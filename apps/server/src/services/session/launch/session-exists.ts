/**
 * Whether a session id names a conversation this server has, for the one
 * route that would otherwise start a new one under any id it is handed.
 *
 * `POST /api/sessions/:id/messages` starts a session on first contact, which is
 * how the app opens a new chat. Without a check, a stale or mistyped id did the
 * same thing silently: it started a stranger session on the default runtime in
 * the default folder, and the sender's words never reached the conversation
 * they meant (DOR-2712). The route now asks this first, and a caller starting
 * a chat says so with `create: true`.
 *
 * @module services/session/launch/session-exists
 */
import { runtimeRegistry, RuntimeNotRegisteredError } from '../../core/runtime-registry.js';
import { resolveSessionCwdOrNull } from '../resolution/resolve-read-cwd.js';

/**
 * Whether `sessionId` names a session this server knows: one bound to a
 * runtime, or one its runtime can find (a live session under an older id, or a
 * transcript from before sessions were bound).
 *
 * A settings row alone does not count. The app writes one for a chat that has
 * not sent its first message, and so does a settings change aimed at an id
 * nobody started, so it proves nothing about whether a conversation exists.
 *
 * Never writes. A session bound to a runtime this server no longer has still
 * exists (the send then says which runtime is missing). Other lookup errors
 * propagate so unavailable native discovery cannot silently create a session.
 *
 * @param sessionId - The id the caller named.
 * @param cwd - The folder the caller named, if any; checked for a transcript
 *   before the default folder.
 */
export async function sessionExists(sessionId: string, cwd?: string): Promise<boolean> {
  try {
    const { runtime, bound } = await runtimeRegistry.resolveForSessionWithOwnership(sessionId);
    if (bound) return true;
    const dir = await resolveSessionCwdOrNull(runtime, sessionId, cwd);
    if (!dir) return false;
    const internalId = runtime.getInternalSessionId(sessionId) ?? sessionId;
    return (await runtime.getSession(dir, internalId)) !== null;
  } catch (err) {
    if (err instanceof RuntimeNotRegisteredError) return true;
    throw err;
  }
}
