/**
 * Tell the person when a spin-off report exhausted every delivery attempt
 * (DOR-3561). `chat-message-wiring.ts` calls this with the real lookups and
 * `notify`; the card is declared in `report-undelivered-notice.ts`. Nothing
 * waits on it: the person opens the spin-off chat to read the report there.
 *
 * @module services/session/chat-messages/report-undelivered
 */
import type { notify } from '../../notifications/notification-service.js';
import type { UndeliveredReport } from './chat-report-back.js';

/** What raising the card needs, passed in by the wiring. */
export interface UndeliveredReportDeps {
  /** The chat's title, or null (the wiring's `chatTitleOf`). */
  titleOf: (sessionId: string) => Promise<string | null>;
  /** The chat's agent home, or null. */
  agentPathOf: (sessionId: string) => Promise<string | null>;
  /** The agent id behind an agent home, or undefined. */
  agentIdOf: (agentPath: string | undefined) => string | undefined;
  /** The notification service's `notify`. */
  notify: typeof notify;
}

/**
 * Raise the Inbox card for a report that never reached its parent chat. The
 * card names the spin-off by its title and never carries the report itself.
 *
 * @param report - The report that exhausted its delivery attempts.
 * @param deps - The title and agent lookups, and `notify`.
 */
export async function notifyUndeliveredReport(
  report: UndeliveredReport,
  deps: UndeliveredReportDeps
): Promise<void> {
  const title = await deps.titleOf(report.sessionId).catch(() => null);
  const sessionLabel = title?.trim() || 'A spin-off chat';
  const agentPath = await deps.agentPathOf(report.sessionId).catch(() => null);
  let agentId: string | undefined;
  try {
    agentId = deps.agentIdOf(agentPath ?? undefined);
  } catch {
    agentId = undefined;
  }
  await deps.notify('report.undelivered', {
    sessionId: report.sessionId,
    parentSessionId: report.parentSessionId,
    sessionLabel,
    ...(agentId ? { agentId } : {}),
    reason: report.reason,
    at: new Date().toISOString(),
  });
}
