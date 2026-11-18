/**
 * The Inbox line when an agent's folder allow list is too long for its
 * approval card (DOR-4455).
 *
 * A person may only approve what they can read in full, so a list whose card
 * would lose a word is never asked about and never applies
 * (`cardShowsWholeList`). Before this line, that was silent: no card, no
 * notice, and a list that could never apply. Security's ruling (Nov 15): say
 * so, naming the agent; never shorten, fold or scroll the list on a card.
 *
 * Raised from the launch, at most once per agent and list for as long as the
 * Inbox keeps the row: 30 days, or sooner on an Inbox past its row cap, when it
 * may be said again. Only the person reads the Inbox, and `relay: 'never'`
 * keeps it off phones and chat apps. The payload carries the agent and a hash
 * of its list, never the rules.
 *
 * @module services/runtimes/claude-code/folder-settings/folder-allow-notice
 */
import type { NotificationRegistryEntry } from '../../../notifications/notification-registry.js';
import { shownName } from '../../../notifications/secret-file-notifications.js';

/** The payload of `agent.folder_rules_too_long`. */
export interface FolderRulesTooLongPayloads {
  'agent.folder_rules_too_long': {
    /** The agent whose folder holds the list. The subject. */
    agentId: string;
    /** Its display name. */
    agentName: string;
    /** A hash of the list, so the same list is said once and a changed one again. */
    hash: string;
  };
}

/**
 * As long as the Inbox keeps a row (`NOTIFICATION_RETENTION_DAYS`, 30): dedupe
 * reads the stored rows, so a longer window would claim a silence the store
 * cannot keep. A list still too long a month later is said again, once.
 */
export const FOLDER_RULES_TOO_LONG_DEDUPE_MS = 30 * 24 * 60 * 60 * 1000;

/** The entry, spread into the registry's `ENTRIES`. */
export const FOLDER_RULES_TOO_LONG_ENTRIES: {
  'agent.folder_rules_too_long': NotificationRegistryEntry<'agent.folder_rules_too_long'>;
} = {
  'agent.folder_rules_too_long': {
    kind: 'agent.folder_rules_too_long',
    // Notable: it lands in the Inbox and never reaches a phone.
    tier: 'notable',
    storage: 'event',
    subjectType: 'agent',
    locate: (p) => ({ subjectId: p.agentId, agentId: p.agentId }),
    // Draft words, pending the designer's (DOR-4455 opens with needs-design).
    title: (p) => `${shownName(p.agentName)}'s folder rules are too long to approve`,
    // No page shows these rules yet, so the body names where they live: both
    // settings files in the folder's `.claude/` (`FOLDER_SETTINGS_FILES`).
    body: () =>
      "Shorten the allow lists in its folder's .claude settings files. Then a card asks you.",
    dedupeKey: (p) => `folder-rules-too-long:${p.agentId}:${p.hash}`,
    dedupeWindowMs: FOLDER_RULES_TOO_LONG_DEDUPE_MS,
    relay: 'never',
  },
};
