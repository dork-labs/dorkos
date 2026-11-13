/**
 * Tell the person when a spin-off report exhausted every delivery attempt
 * (DOR-3561). `chat-message-wiring.ts` calls this; the card is declared in
 * `report-undelivered-notice.ts`. Nothing waits on it: the person opens the
 * spin-off chat to read the report there.
 *
 * @module services/session/chat-messages/report-undelivered
 */
import { resolveAgentIdForPath } from '../../mesh/agent-path-lookup.js';
import { notify } from '../../notifications/notification-service.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import type { UndeliveredReport } from './chat-report-back.js';

/**
 * Raise the Inbox card for a report that never reached its parent chat. The
 * card names the spin-off by its title and never carries the report itself.
 *
 * @param report - The report that exhausted its delivery attempts.
 * @param titleOf - The chat's title, or null (the wiring's `chatTitleOf`).
 */
export async function notifyUndeliveredReport(
  report: UndeliveredReport,
  titleOf: (sessionId: string) => Promise<string | null>
): Promise<void> {
  const title = await titleOf(report.sessionId).catch(() => null);
  const sessionLabel = title?.trim() || 'A spin-off chat';
  const agentPath = await runtimeRegistry.getSessionAgentPath(report.sessionId).catch(() => null);
  let agentId: string | undefined;
  try {
    agentId = resolveAgentIdForPath(agentPath ?? undefined);
  } catch {
    agentId = undefined;
  }
  await notify('report.undelivered', {
    sessionId: report.sessionId,
    parentSessionId: report.parentSessionId,
    sessionLabel,
    ...(agentId ? { agentId } : {}),
    reason: report.reason,
    at: new Date().toISOString(),
  });
}
