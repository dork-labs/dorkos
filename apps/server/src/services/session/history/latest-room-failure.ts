/** Narrow prior-turn evidence; callers must separately prove current guards/account/transcript. */
import type { SessionEvent } from '@dorkos/shared/session-stream';

export interface PriorRoomServerFailure {
  startSeq: number;
  endSeq: number;
  entryId: string;
  dispatchId: string;
}

/** Unknown, mixed and protected facts refuse. A marker without its cause grants nothing. */
export function latestClaudeRoomServerFailure(
  events: readonly SessionEvent[] | null,
  roomId: string
): PriorRoomServerFailure | null {
  if (!events || events.length < 4) return null;
  const start = events[0];
  const end = events.at(-1);
  if (start.type !== 'turn_start' || end?.type !== 'turn_end') return null;
  if (start.origin === 'runtime' || start.roomMessage?.roomId !== roomId) return null;
  if (end.terminalReason !== 'error' || end.stopWasRequested === true) return null;
  let cause = false;
  let wrapper = false;
  let dispatchId: string | undefined;
  for (const event of events.slice(1, -1)) {
    // A model-request measurement is not an error or a permission decision.
    if (event.type === 'model_request') continue;
    if (event.type !== 'error' || event.category !== 'execution_error') return null;
    if (event.code === 'server_error' && event.reason === undefined && !wrapper) cause = true;
    else if (
      event.code === 'error_during_execution' &&
      event.reason === 'claude-server-error-terminal' &&
      event.sourceDispatchId !== undefined &&
      cause &&
      !wrapper
    ) {
      wrapper = true;
      dispatchId = event.sourceDispatchId;
    } else return null;
  }
  return cause && wrapper && dispatchId
    ? { startSeq: start.seq, endSeq: end.seq, entryId: start.roomMessage.entryId, dispatchId }
    : null;
}
