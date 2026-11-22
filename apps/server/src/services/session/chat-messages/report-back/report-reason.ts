/** Select a report outcome from the status captured at its turn boundary. */
import type { SessionStatus } from '@dorkos/shared/session-stream';
import type { ReportReason } from '../chat-report-back.js';

/**
 * Why a turn that just ended is worth a report: a person-facing wait reports separately.
 *
 * @param status - The chat's live status, or null when no status says otherwise.
 */
export function reasonOf(
  status: SessionStatus | null
): Exclude<ReportReason, 'holding' | 'never-started'> | null {
  if (!status) return 'finished';
  if (status.limit) return 'limit';
  switch (status.lifecycle) {
    case 'error':
      return 'failed';
    case 'interrupted':
      return 'stopped';
    case 'blocked':
      return null;
    default:
      return 'finished';
  }
}
