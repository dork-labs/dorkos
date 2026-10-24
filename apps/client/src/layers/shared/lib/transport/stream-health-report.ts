/**
 * Tell the server a window's live stream missed a turn
 * (`POST /api/sessions/:id/stream-health`), so the miss lands in its log.
 *
 * Fire-and-forget, like crash reporting: it must never throw, never block the
 * reconnect it rides beside, and never surface to the person.
 *
 * @module shared/lib/transport/stream-health-report
 */
import type { StreamHealthReport } from '@dorkos/shared/schemas';

/**
 * Post one report. Swallows every failure.
 *
 * @param baseUrl - The API base the streams use (`/api`, or an absolute origin
 *   in packaged Electron).
 * @param sessionId - The session whose stream missed the turn.
 * @param report - What was missed.
 */
export function postStreamHealthReport(
  baseUrl: string,
  sessionId: string,
  report: StreamHealthReport
): void {
  try {
    void fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/stream-health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(report),
    }).catch(() => {});
  } catch {
    // Reporting must never get in the way of the reconnect.
  }
}
