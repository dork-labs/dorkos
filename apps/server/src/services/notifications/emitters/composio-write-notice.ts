/** One notice per account whose old write level was lowered on upgrade (DOR-4461). */
import type { NotificationRegistryEntry } from '../notification-registry.js';

/** The account named by the write-access upgrade notice. */
export interface ComposioWriteNoticePayloads {
  'connector.write_available': { connectionId: string; appName: string; accountLabel?: string };
}

/** The entry used both for the atomic boot write and for reading its history. */
export const COMPOSIO_WRITE_NOTICE_ENTRIES: {
  'connector.write_available': NotificationRegistryEntry<'connector.write_available'>;
} = {
  'connector.write_available': {
    kind: 'connector.write_available',
    tier: 'notable',
    storage: 'event',
    subjectType: 'system',
    locate: (p) => ({ subjectId: p.connectionId }),
    title: (p) => {
      const label = p.accountLabel?.trim();
      const account =
        label && label.toLowerCase() !== p.appName.trim().toLowerCase()
          ? `${p.appName} (${label})`
          : p.appName;
      return `${account} access changed to Read`;
    },
    body: () => 'Access is now Read. Review this account to allow changes.',
    dedupeKey: (p) => `composio-write-upgrade:${p.connectionId}`,
    relay: 'never',
  },
};
