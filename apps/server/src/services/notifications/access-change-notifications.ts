/**
 * The Needs-you row when one agent takes another agent's connection access
 * away (spec `agent-grant-autonomy` §8, Security G2): seen when it happens, not
 * when something breaks, with Undo and Keep the change.
 *
 * The row carries no reason. The agent's reason is its own words, and
 * notifications are read by agents too, so the app reads it from the person's
 * own route by `changeId` and shows it attributed, as plain text.
 *
 * The emitter is `services/connectors/access/access-change-events.ts`.
 *
 * @module services/notifications/access-change-notifications
 */
import type { NotificationActionDTO } from '@dorkos/shared/notification-schemas';
import type { NotificationRegistryEntry } from './notification-registry.js';

/** The intent behind Undo: `POST /api/connectors/access-changes/:changeId/undo`. */
export const UNDO_ACCESS_CHANGE_ACTION_ID = 'undo-access-change';

/** The intent behind Keep the change: mark the row read. */
export const KEEP_ACCESS_CHANGE_ACTION_ID = 'keep-access-change';

/** The payload of `connector.access_narrowed`. */
export interface AccessChangePayloads {
  'connector.access_narrowed': {
    /** The ledger row; what Undo undoes. */
    changeId: string;
    /** The app. */
    connectionId: string;
    /** The agent that made the change. */
    actorAgentId: string;
    /** The agent whose access changed. The lens key. */
    targetAgentId: string;
    /** The sentence, e.g. `DorkOS PM took Gmail (Work) access away from flow-snapshot`. */
    title: string;
  };
}

const ACTIONS: NotificationActionDTO[] = [
  { id: UNDO_ACCESS_CHANGE_ACTION_ID, label: 'Undo', style: 'neutral' },
  { id: KEEP_ACCESS_CHANGE_ACTION_ID, label: 'Keep the change', style: 'primary' },
];

/** The entry, spread into the registry's `ENTRIES`. */
export const ACCESS_CHANGE_ENTRIES: {
  'connector.access_narrowed': NotificationRegistryEntry<'connector.access_narrowed'>;
} = {
  'connector.access_narrowed': {
    kind: 'connector.access_narrowed',
    tier: 'blocking',
    storage: 'event',
    subjectType: 'system',
    locate: (p) => ({ subjectId: p.changeId, agentId: p.targetAgentId }),
    title: (p) => p.title,
    body: () => 'Undo puts it back.',
    actions: () => ACTIONS,
    dedupeKey: (p) => `access-change:${p.changeId}`,
    relay: 'never',
  },
};
