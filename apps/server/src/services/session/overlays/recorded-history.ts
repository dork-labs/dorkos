/**
 * Everything the server put back over a runtime's own history from its durable
 * event record, in one call, for a runtime whose store keeps none of it:
 * a model DorkOS credits ran in place of the chosen one (DOR-2636), a summary
 * the agent asked for (DOR-2732), and which room post opened a turn (DOR-2113).
 *
 * @module services/session/overlays/recorded-history
 */
import type { HistoryMessage } from '@dorkos/shared/types';
import { overlayAgentCompactions } from './agent-compaction-overlay.js';
import { overlayModelSubstitutions } from './model-substitution-overlay.js';
import { overlayRoomMessages } from './room-message-overlay.js';

/**
 * Lay the recorded facts back over a session's history.
 *
 * @param sessionId - The DorkOS session id.
 * @param messages - The runtime's own history.
 */
export function overlayRecordedHistory(
  sessionId: string,
  messages: HistoryMessage[]
): HistoryMessage[] {
  return overlayRoomMessages(
    sessionId,
    overlayAgentCompactions(sessionId, overlayModelSubstitutions(sessionId, messages))
  );
}
