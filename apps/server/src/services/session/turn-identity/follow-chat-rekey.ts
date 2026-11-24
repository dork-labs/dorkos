/**
 * The id a chat answers under now, for a caller that holds an older one.
 *
 * A brand-new chat is first named by the app's own UUID, and its runtime then
 * renames it once to the id the runtime minted (ADR-0267). Anything copied in
 * those first seconds, such as a `dork:chat:` link, holds the retired id. Two
 * records follow the rename, read in this order:
 *
 * 1. The session projector's one-way redirect from the retired id to the live
 *    one, kept while the chat's projector lives ({@link peekProjector}).
 * 2. A record that outlives a restart, registered by its owner through
 *    {@link registerDurableRekeyResolver}. The work graph's `rekeyed_from`
 *    edges are that record; they are space data, so the session domain never
 *    imports them (the `work-graph/stay-out` lint rule) and asks this hook.
 *
 * The one place a link (or anything else holding a chat id from outside)
 * follows a re-key, so every caller follows both.
 *
 * @module services/session/turn-identity/follow-chat-rekey
 */
import { logger } from '../../../lib/logger.js';
import { peekProjector } from '../session-state-projector.js';

/**
 * Looks a chat id up in a record that outlives a restart.
 *
 * @param sessionId - The id the caller holds.
 * @returns The chat's current id; `sessionId` itself when it was never re-keyed.
 */
export type DurableRekeyResolver = (sessionId: string) => string;

let durableResolver: DurableRekeyResolver | null = null;

/**
 * Register the durable record {@link followChatRekey} reads when the in-memory
 * redirect has nothing. There is one slot: registering replaces whatever was
 * there, so registering the same resolver twice still consults it once.
 *
 * @param resolver - The durable lookup.
 * @returns Unregisters `resolver`, if it is still the registered one.
 */
export function registerDurableRekeyResolver(resolver: DurableRekeyResolver): () => void {
  durableResolver = resolver;
  return () => {
    if (durableResolver === resolver) durableResolver = null;
  };
}

/**
 * The id a chat answers under now: `sessionId` itself unless it was retired by
 * a re-key, in which case the id it moved to. The in-memory redirect answers
 * first; the durable record is asked only when no projector knows the id. A
 * durable lookup that throws is logged and ignored, and the id is answered as
 * given.
 *
 * @param sessionId - The id the caller holds.
 * @returns The chat's current id.
 */
export function followChatRekey(sessionId: string): string {
  const live = peekProjector(sessionId)?.sessionId;
  if (live !== undefined) return live;
  if (durableResolver === null) return sessionId;
  try {
    return durableResolver(sessionId);
  } catch {
    logger.warn('[followChatRekey] the durable re-key lookup failed; using the id as given', {
      sessionId,
    });
    return sessionId;
  }
}
