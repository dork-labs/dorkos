/**
 * One try at delivering a report (spec `spin-off-chats` §5): into a room's
 * seat as a turn of its own when the parent is one, else as a `report` chat
 * message. Kept apart from `chat-report-back.ts`, which stays under the size rule.
 *
 * @module services/session/chat-messages/report-back/deliver-report
 */
import type { TurnMarks } from '../../../core/turn-power/turn-marks.js';
import type { ChatCaller } from '../chat-message-service.js';
import type { ChatReportBackDeps } from '../chat-report-back.js';
import { SUMMARY, type ReportNotice } from './report-words.js';

/** One report, as it goes out. */
export interface OutgoingReport {
  /** The chat the report speaks for. */
  sessionId: string;
  /** The chat it goes to. */
  parent: string;
  reason: ReportNotice;
  /** The marks of the turn it speaks for. */
  marks: TurnMarks;
  message: string;
  /** Its words count as outside words (a capture that could not be saved). */
  outsideWords: boolean;
}

/**
 * One try at a report. Throws when it did not land.
 *
 * @param deps - Report-back's dependencies: the agent home, the seat route and the sender.
 * @param report - The report.
 */
export async function deliverReport(
  deps: Pick<ChatReportBackDeps, 'agentPathOf' | 'toRoomSeat' | 'service'>,
  report: OutgoingReport
): Promise<void> {
  const { sessionId, parent, reason, marks, message, outsideWords } = report;
  const agentPath = await deps.agentPathOf(sessionId).catch(() => null);
  if (!agentPath) throw new Error('The chat has no agent home to report as.');
  // A room's seat gets the report as a turn of its own, never through chat_send's seat path,
  // which leaves a note in the room and is refused in a bridged room (DOR-4472).
  const toSeat = deps.toRoomSeat;
  if (
    toSeat &&
    (await toSeat(parent, {
      fromSessionId: sessionId,
      fromAgentPath: agentPath,
      text: message,
      marks,
      ...(outsideWords ? { outsideWords: true } : {}),
    }))
  ) {
    return;
  }
  const caller: ChatCaller = {
    sessionId,
    agentPath,
    marksAtTurnEnd: marks,
    ...(outsideWords ? { outsideWordsAtTurnEnd: true } : {}),
  };
  await deps.service.send(caller, { to: parent, message, summary: SUMMARY[reason] }, 'report');
}
