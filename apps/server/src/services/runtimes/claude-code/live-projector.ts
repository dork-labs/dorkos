/**
 * Find a claude-code chat's live projector, and say so when it belongs to
 * another chat (DOR-4552).
 *
 * @module services/runtimes/claude-code/live-projector
 */
import { logger } from '../../../lib/logger.js';
import { peekProjector, type SessionStateProjector } from '../../session/index.js';

/**
 * The live projector for a chat, looked up under the id asked for and then
 * under the SDK id that chat runs under. `undefined` when neither has one.
 *
 * A projector found this way must answer to one of those two ids. One that
 * answers to neither is another chat's live turn, and a window opened on this
 * chat would show that turn under this chat's history. That has never been
 * reproduced, so it is reported, not refused: a rename chain this check
 * misread would otherwise hide a chat's own reply.
 *
 * @param sessionId - The id the caller holds: a request UUID or a canonical id.
 * @param internalId - The SDK id that chat runs under, when known.
 */
export function peekLiveProjector(
  sessionId: string,
  internalId: string | undefined
): SessionStateProjector | undefined {
  const projector = peekProjector(sessionId) ?? peekProjector(internalId ?? sessionId);
  if (
    projector !== undefined &&
    projector.sessionId !== sessionId &&
    projector.sessionId !== internalId
  ) {
    logger.warn("[ClaudeCodeRuntime] a chat resolved to another chat's live state", {
      sessionId,
      internalId,
      projectorSessionId: projector.sessionId,
    });
  }
  return projector;
}
