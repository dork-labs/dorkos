/**
 * Find a claude-code chat's live projector, and say so when it belongs to
 * another chat (DOR-4552).
 *
 * @module services/runtimes/claude-code/live-projector
 */
import { logger } from '../../../lib/logger.js';
import { peekProjector, type SessionStateProjector } from '../../session/index.js';

/**
 * Pairs already reported, so a stuck mismatch logs once rather than on every
 * snapshot, subscribe and generation read from every open window. Cleared at
 * its cap: a later repeat is worth one more line.
 */
const reported = new Set<string>();
const MAX_REPORTED = 256;

/**
 * The live projector for a chat, looked up under the id asked for and then
 * under the SDK id that chat runs under. `undefined` when neither has one.
 *
 * The projector found must belong to the same chat. Ids alone cannot say so:
 * a chat answers to its request UUID and every id the SDK has minted for it,
 * and the projector renames itself one event behind the session store. So the
 * runtime decides, through its own alias resolver. One that belongs to another
 * chat is that chat's live turn, and a window opened here would show it under
 * this chat's history. Not reproduced as of DOR-4552, so it is reported, not
 * refused: a misjudged rename would otherwise hide a chat's own reply.
 *
 * @param sessionId - The id the caller holds: a request UUID or any id the SDK minted.
 * @param internalId - The SDK id that chat runs under, when known.
 * @param chats - The runtime's alias resolver: every id one chat answers to maps to one key.
 */
export function peekLiveProjector(
  sessionId: string,
  internalId: string | undefined,
  chats: { sessionKeyOf(id: string): string }
): SessionStateProjector | undefined {
  const projector = peekProjector(sessionId) ?? peekProjector(internalId ?? sessionId);
  if (projector === undefined) return undefined;
  const owner = projector.sessionId;
  const sameChat = chats.sessionKeyOf(owner) === chats.sessionKeyOf(sessionId);
  if (owner === sessionId || owner === internalId || sameChat) return projector;
  const pair = `${sessionId}>${owner}`;
  if (!reported.has(pair)) {
    if (reported.size >= MAX_REPORTED) reported.clear();
    reported.add(pair);
    logger.warn("[ClaudeCodeRuntime] a chat resolved to another chat's live state", {
      sessionId,
      internalId,
      projectorSessionId: owner,
    });
  }
  return projector;
}
