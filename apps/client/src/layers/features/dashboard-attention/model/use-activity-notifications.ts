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
import type { NotificationDTO, NotificationKind } from '@dorkos/shared/notification-schemas';
import { useNow } from '@/layers/shared/model';
import { isFailedRun, useNotifications } from '@/layers/entities/notifications';

/** Maximum number of rows the group draws. */
const MAX_ITEMS = 8;

/**
 * How far back something is still worth mentioning on the home surface.
 *
 * Carried over from the hook this replaces. The Inbox itself keeps 30 days —
 * that is where you go to find out what happened last week — but this group sits
 * above a conversation and answers "what is wrong right now", and an agent that
 * went unreachable on Tuesday is not that.
 */
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * The kinds that belong in "Recent activity" — things that happened, not blockages.
 *
 * A LENS, sent to the server, not a filter applied to the bell's page. Sieving
 * the unfiltered list would mean a working morning's 25 finished turns hide the
 * one run that failed, and whether the failure is visible at all would depend on
 * somebody having pressed "Load more".
 */
const ACTIVITY_KINDS: readonly NotificationKind[] = [
  'run.completed',
  'dead-letter.created',
  'agent.unreachable',
];

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
 * Failed runs, undeliverable Relay messages and agents that stopped answering
 * within the last day, newest first.
 *
 * Its own paged query on its own lens, sharing nothing with the bell's cache —
 * which is the whole point: this group has to be able to show a failure from
 * eight hours ago even when a hundred turns finished since.
 *
 * A successful run is left out. It is a `quiet` notification — real history,
 * worth finding in the Inbox — but "Recent activity" on the home surface is the
 * group for things that went wrong, and filling it with successes is how the
 * group stopped being read the last time.
 */
export function useActivityNotifications(): ActivityNotificationsState {
  const { notifications, isLoading } = useNotifications({ kinds: ACTIVITY_KINDS });
  // Ticks on the shared clock rather than reading `Date.now()` in render, which
  // is impure and would make the cutoff shift under React on every re-render.
  const now = useNow();

  const items = useMemo(() => {
    const since = now - TWENTY_FOUR_HOURS_MS;
    const rows = notifications.filter(
      (n) =>
        new Date(n.createdAt).getTime() > since && (n.kind !== 'run.completed' || isFailedRun(n))
    );
    return rows.length === 0 ? NO_ITEMS : rows.slice(0, MAX_ITEMS);
  }, [notifications, now]);

  return { items, isLoading };
}
