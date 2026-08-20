/**
 * What recently went wrong, read out of the Inbox.
 *
 * **This used to derive itself.** `useRecentActivityItems` polled failed runs,
 * aggregated dead letters and mesh liveness and built rows from three unrelated
 * queries — a fourth attention-ish engine in a codebase that had already agreed
 * to have one. DOR-1384 deleted it: the same three facts now arrive as
 * server-emitted Activity notifications (`run.completed`, `dead-letter.created`,
 * `agent.unreachable`), so the row a person sees here is the same row the bell
 * shows and the same one a phone will eventually push.
 *
 * @module features/dashboard-attention/model/use-activity-notifications
 */
import { useMemo } from 'react';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { isFailedRun, useNotifications } from '@/layers/entities/notifications';

/** Maximum number of rows the group draws. */
const MAX_ITEMS = 8;

/** The kinds that belong in "Recent activity" — things that happened, not blockages. */
const ACTIVITY_KINDS = new Set(['run.completed', 'dead-letter.created', 'agent.unreachable']);

/** Shared empty, so a quiet cockpit never mints a fresh array identity. */
const NO_ITEMS: readonly NotificationDTO[] = [];

/** The rows plus whether the Inbox is still on its first read. */
export interface ActivityNotificationsState {
  /** The rows, most recent first and capped at {@link MAX_ITEMS}. */
  items: readonly NotificationDTO[];
  /**
   * True while the Inbox is still on its first load, so a consumer can withhold
   * an "all clear" until the data that would justify it has actually arrived —
   * otherwise the reassurance flashes before a row pops in.
   */
  isLoading: boolean;
}

/**
 * Failed runs, undeliverable Relay messages and agents that stopped answering,
 * newest first.
 *
 * Narrowed in place rather than fetched per kind: the route takes one `kind` and
 * this wants three, and reading the unfiltered list means sharing the bell's
 * cache instead of opening three more requests for rows it already holds.
 *
 * A successful run is left out. It is a `quiet` notification — real history,
 * worth finding in the Inbox — but "Recent activity" on the home surface is the
 * group for things that went wrong, and filling it with successes is how the
 * group stopped being read the last time.
 */
export function useActivityNotifications(): ActivityNotificationsState {
  const { notifications, isLoading } = useNotifications();

  const items = useMemo(() => {
    const rows = notifications.filter(
      (n) => ACTIVITY_KINDS.has(n.kind) && (n.kind !== 'run.completed' || isFailedRun(n))
    );
    return rows.length === 0 ? NO_ITEMS : rows.slice(0, MAX_ITEMS);
  }, [notifications]);

  return { items, isLoading };
}
