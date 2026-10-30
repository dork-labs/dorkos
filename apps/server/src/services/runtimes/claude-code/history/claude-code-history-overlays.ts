/**
 * Everything DorkOS lays back over a Claude Code transcript from its own
 * durable record, in order, in one call.
 *
 * @module services/runtimes/claude-code/history/claude-code-history-overlays
 */
import type { HistoryMessage } from '@dorkos/shared/types';
import {
  overlayAgentCompactions,
  overlayApprovalReceipts,
  overlayModelSubstitutions,
  overlayPermissionDenials,
  overlayWorkLeftRunning,
} from '../../../session/index.js';
import { overlayTurnCutoffs } from './turn-cutoff-overlay.js';

/**
 * Lay the recorded facts back over a Claude Code session's history.
 *
 * 1. The decisions a person made on DorkOS cards (`overlayApprovalReceipts`).
 * 2. The refusals nobody was asked about (DOR-795): a BACKGROUNDED subagent's
 *    denied tool call is written into the child's transcript, not this one, so
 *    without this the conversation shows an agent that stopped for no reason.
 * 3. Background commands a Stop could not end (DOR-3285): the transcript
 *    records neither the line nor how each command later ended.
 * 4. Turns that ran on another model than the session names, because DorkOS
 *    credits do not cover it (DOR-2636): the transcript names the model that
 *    ran and never the one it replaced.
 * 5. Summaries the agent asked for itself (DOR-2732): the transcript records
 *    that the conversation was summarized, never who asked.
 * 6. Turns DorkOS cut off (DOR-3307): the CLI wrote that interrupt as a
 *    person's. Last, so it can take back the "declined" step 1 and the parser
 *    inferred from the CLI's refusal text.
 *
 * @param sessionId - The DorkOS session id.
 * @param messages - History as the transcript parser assembled it.
 */
export function overlayClaudeCodeHistory(
  sessionId: string,
  messages: HistoryMessage[]
): HistoryMessage[] {
  const receipted = overlayPermissionDenials(
    sessionId,
    overlayApprovalReceipts(sessionId, messages)
  );
  const stopped = overlayWorkLeftRunning(sessionId, receipted);
  const annotated = overlayAgentCompactions(
    sessionId,
    overlayModelSubstitutions(sessionId, stopped)
  );
  return overlayTurnCutoffs(sessionId, annotated);
}
