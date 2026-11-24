/**
 * The id a chat answers under now, for a caller that holds an older one.
 *
 * A brand-new chat is first named by the app's own UUID, and its runtime then
 * renames it once to the id the runtime minted (ADR-0267). Anything copied in
 * those first seconds, such as a `dork:chat:` link, holds the retired id. The
 * session projector keeps a one-way redirect from the retired id to the live
 * one while the chat's projector lives ({@link peekProjector}), and this reads
 * it.
 *
 * The one place a link (or anything else holding a chat id from outside)
 * follows a re-key, so a longer-lived lookup that survives a restart is added
 * here and every caller follows it.
 *
 * @module services/session/turn-identity/follow-chat-rekey
 */
import { peekProjector } from '../session-state-projector.js';

/**
 * The id a chat answers under now: `sessionId` itself unless it was retired by
 * a re-key, in which case the id it moved to.
 *
 * @param sessionId - The id the caller holds.
 * @returns The chat's current id.
 */
export function followChatRekey(sessionId: string): string {
  return peekProjector(sessionId)?.sessionId ?? sessionId;
}
