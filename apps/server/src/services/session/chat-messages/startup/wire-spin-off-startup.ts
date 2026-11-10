/**
 * Runtime-neutral first-turn monitoring, using the same report-back sender as turn endings.
 */
import { onSessionRemoved } from '../../catalog/session-list-broadcaster.js';
import { getMessageQueueStore } from '../../message-queue-store.js';
import { queueKeyOf } from '../../resolution/session-key-registry.js';
import { onProjectorRekey, peekProjector } from '../../session-state-projector.js';
import type { ChatReportBack } from '../chat-report-back.js';
import { getSpinOffStartup, setSpinOffStartup, SpinOffStartup } from './spin-off-startup.js';

/** Prefer an observed error or held limit; a queue or missing start is otherwise all we know. */
export function startupFailureReason(sessionId: string, fallback?: string): string {
  const status = peekProjector(sessionId)?.getStatus();
  if (status?.lastError?.message) return status.lastError.message;
  if (status?.limit) return 'The selected account is at its usage limit.';
  if (fallback) return fallback;
  if (getMessageQueueStore()?.list(queueKeyOf(sessionId)).length) {
    return 'The first message is still queued.';
  }
  return 'The runtime did not start its first turn within five minutes.';
}

/** Arm from session_start; clear only when the agent produces output or the chat disappears. */
export function wireSpinOffStartup(reports: Pick<ChatReportBack, 'onNeverStarted'>): () => void {
  const startup = new SpinOffStartup({
    failureReason: startupFailureReason,
    report: (sessionId, reason, marks) => reports.onNeverStarted(sessionId, reason, marks),
  });
  setSpinOffStartup(startup);
  const offRekey = onProjectorRekey((from, to) => startup.rekey(from, to));
  const offRemoved = onSessionRemoved((sessionId) => startup.forget(sessionId));
  return () => {
    offRekey();
    offRemoved();
    startup.stop();
    if (getSpinOffStartup() === startup) setSpinOffStartup(undefined);
  };
}
