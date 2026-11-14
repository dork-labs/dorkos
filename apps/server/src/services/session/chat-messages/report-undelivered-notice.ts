/**
 * The Inbox event raised when a spin-off report cannot reach the chat that
 * started it (DOR-3561). The emitter is `report-undelivered.ts`, called from
 * `chat-message-wiring.ts`. It is notable because nothing waits on the person;
 * they open the spin-off chat to read the report.
 *
 * Declared beside its emitter and spread into the registry through
 * `notifications/declared-entries.ts`, like `mesh/global-mcp/global-mcp-tool-added-notice.ts`.
 * Types only: importing it never loads the notification service.
 *
 * @module services/session/chat-messages/report-undelivered-notice
 */
import type { NotificationActionDTO } from '@dorkos/shared/notification-schemas';
import type { NotificationRegistryEntry } from '../../notifications/notification-registry.js';

/** The payload of the undelivered-report kind, joined into `NotificationPayloads`. */
export interface ReportUndeliveredPayloads {
  /** A spin-off report exhausted every delivery attempt. */
  'report.undelivered': {
    /** The spin-off chat whose report did not arrive. */
    sessionId: string;
    /** The chat that started the spin-off and did not receive its report. */
    parentSessionId: string;
    /** The title of the spin-off chat. */
    sessionLabel: string;
    /** The agent that owns the spin-off, when known. */
    agentId?: string;
    /** Why the report went. */
    reason: 'finished' | 'failed' | 'stopped' | 'limit' | 'needs-you' | 'holding' | 'never-started';
    /** ISO time when report-back gave up. */
    at: string;
  };
}

/** The one place to read a report that did not reach its parent chat. */
const OPEN_CHAT_ACTION: NotificationActionDTO[] = [
  { id: 'open-chat', label: 'Open chat', style: 'primary' },
];

/** The undelivered-report entry, spread into the registry's `ENTRIES`. */
export const REPORT_UNDELIVERED_ENTRIES: {
  [K in keyof ReportUndeliveredPayloads]: NotificationRegistryEntry<K>;
} = {
  'report.undelivered': {
    kind: 'report.undelivered',
    tier: 'notable',
    storage: 'event',
    subjectType: 'session',
    locate: (p) => ({
      subjectId: p.sessionId,
      sessionId: p.sessionId,
      ...(p.agentId ? { agentId: p.agentId } : {}),
    }),
    title: (p) => `A report from ${p.sessionLabel} didn't arrive`,
    body: () => 'It never reached the chat that started it. Open the chat to read it.',
    actions: () => OPEN_CHAT_ACTION,
    dedupeKey: (p) => `report-undelivered:${p.sessionId}:${p.at}`,
    relay: 'never',
  },
};
