/**
 * What DorkOS tells a person when an agent hands them the Agent browser
 * (DOR-3218). It's the one thing a phone sees: the browser's own routes refuse a
 * phone, and the window is on the computer, so this row has no buttons. The live
 * card, on the computer, answers the handoff.
 *
 * Declared here and spread into the registry, like `web-device-notifications.ts`.
 * The words are fixed. The site is the host of the agent's page, from its URL. The
 * name is the agent's verified name, cut short, because agents choose their own.
 *
 * @module services/notifications/browser-handoff-notifications
 */
import type { NotificationRegistryEntry } from './notification-registry.js';

/** The most of an agent's name a row shows. */
const MAX_AGENT_NAME = 40;

/** The agent's name, without control or direction characters, cut short with an ellipsis. */
function shortName(name: string | null): string {
  const whole = name?.replace(/[\p{Cc}\p{Cf}]/gu, '') || 'The agent';
  return whole.length > MAX_AGENT_NAME ? `${whole.slice(0, MAX_AGENT_NAME)}…` : whole;
}

/** The payload of the one kind, joined into `NotificationPayloads`. */
export interface BrowserHandoffPayloads {
  /** An agent handed the Agent browser to a person and stopped. One row per handoff. */
  'browser.handoff': {
    handoffId: string;
    sessionId: string;
    /** The host of the agent's page when it asked. */
    site: string;
    /** The asking agent's verified name, or null when the call carried none. */
    agentName: string | null;
    /** The asking agent's registry id, when known. */
    agentId: string | null;
  };
}

/** The one entry, spread into the registry's `ENTRIES`. */
export const BROWSER_HANDOFF_ENTRIES: {
  [K in keyof BrowserHandoffPayloads]: NotificationRegistryEntry<K>;
} = {
  'browser.handoff': {
    kind: 'browser.handoff',
    // Notable, not blocking: the live card is what counts toward the badge. This
    // row is the record, and the only word that reaches a phone.
    tier: 'notable',
    storage: 'event',
    subjectType: 'session',
    locate: (p) => ({
      subjectId: p.sessionId,
      sessionId: p.sessionId,
      ...(p.agentId ? { agentId: p.agentId } : {}),
    }),
    title: (p) => `${p.site} wants a person to continue`,
    body: (p) => `${shortName(p.agentName)} is paused. Continue on your computer.`,
    dedupeKey: (p) => `browser-handoff:${p.handoffId}`,
    relay: 'never',
  },
};
