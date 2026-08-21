/**
 * The Inbox list — the one component every lens draws.
 *
 * The bell's Activity section, an agent's Notifications page and (later) a
 * session's are the same list over a different lens, so they are the same
 * component over a different lens. Anything a surface wants to add — a
 * "Mark all read" header, a title — it puts around this, not inside it.
 *
 * @module features/inbox/ui/InboxList
 */
import { useCallback, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { Button } from '@/layers/shared/ui';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import {
  notificationLink,
  useNotifications,
  type NotificationLens,
} from '@/layers/entities/notifications';
import { useOpenNotification } from '../model/use-open-notification';
import { groupActivityRows, groupStateKey } from '../lib/group-activity-rows';
import { InboxRow } from './InboxRow';
import { InboxGroupRow } from './InboxGroupRow';

/** The stagger the rows inherit — each row declares the child half. */
const staggerContainer = {
  animate: { transition: { staggerChildren: 0.03 } },
} as const;

export interface InboxListProps {
  /** Which slice of the Inbox to draw. Omit for all of it. */
  lens?: NotificationLens;
  /** What to say when there is nothing. */
  emptyLabel?: string;
  /**
   * Called after a row has been opened, so a host can get out of the way.
   *
   * The popover uses it to close itself; a page passes nothing.
   */
  onOpened?: () => void;
}

/**
 * Everything that has happened, newest first.
 *
 * **Clicking a row does two things, in this order.** It marks the row read — the
 * click IS the reading, and waiting for the destination to load before dimming
 * it would leave a bold row behind on the way out — and then it navigates.
 *
 * **A row with nowhere to go draws as text, not a dead button.** `update.installed`
 * and `report.daily` are the two kinds `notificationLink` returns `null` for —
 * there is no destination, and a full-width button that visibly does nothing
 * but clear the dot reads as broken. `InboxRow` already has the non-interactive
 * branch for exactly this (its `onOpen` is optional); this is the surface that
 * now actually takes it. Its unread dot still clears through "Mark all read" —
 * the row itself just is not a control pretending to travel somewhere.
 *
 * **Bursts of three or more collapse.** Three-plus consecutive rows sharing an
 * agent, a kind and a tone (`groupActivityRows`) fold into one `InboxGroupRow`
 * — a pure reshape of whatever `useNotifications` already returned, run again
 * whenever that list changes. It never asks for more than the lens already
 * fetched and never trims it, so paging and the live cap stay entirely
 * `entities/notifications`'s job. This component owns which groups are open
 * (a `Set` keyed by `groupStateKey`, not `InboxGroupRow`'s own state) for the
 * reason its own inline comment gives; the guarantee that expansion is
 * ephemeral and forgets itself on popover close is unaffected — it now comes
 * from this component unmounting rather than `InboxGroupRow`'s.
 *
 * Paging is a button rather than a scroll sentinel: the list lives inside a
 * popover barely taller than a phone, and an infinite scroller in a 30rem panel
 * fetches the whole history for anybody who flicks it.
 *
 * @param props - The {@link InboxListProps.lens} and what happens after a row opens.
 */
export function InboxList({ lens, emptyLabel = 'Nothing yet', onOpened }: InboxListProps) {
  const { notifications, isLoading, isError, hasMore, loadMore, isLoadingMore } =
    useNotifications(lens);
  const openNotification = useOpenNotification();

  // The roster, for the face each row/group draws when its `agentId` names a
  // known agent. One query, shared by every row through TanStack's cache —
  // rendering fifty rows costs the one request the first row's hook fires.
  const { data: agentsData } = useRegisteredAgents();
  const agentsById = useMemo(() => {
    const map = new Map<string, AgentManifest>();
    for (const agent of agentsData?.agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agentsData]);
  const resolveAgent = useCallback(
    (agentId: string | undefined) =>
      agentId === undefined ? undefined : (agentsById.get(agentId) ?? null),
    [agentsById]
  );

  const handleOpen = useCallback(
    (notification: NotificationDTO) => {
      openNotification(notification);
      onOpened?.();
    },
    [openNotification, onOpened]
  );

  const items = useMemo(() => groupActivityRows(notifications), [notifications]);

  // Which groups are open, keyed by `groupStateKey` rather than by any
  // group's own React key — see `InboxGroupRow`'s class doc for why a key
  // tied to a group's MEMBERSHIP breaks the moment that membership changes
  // shape. Lives here (and not in `InboxGroupRow` itself) for exactly one
  // reason: a `Set` in local component state unmounts with this component,
  // which is what "ephemeral, collapses on popover close" already meant
  // before expand state moved — Radix drops the popover's content on close,
  // taking this whole tree with it.
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    () => new Set<string>()
  );
  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (isLoading) {
    return <p className="text-muted-foreground px-2 py-1 text-xs">Loading…</p>;
  }

  if (isError && notifications.length === 0) {
    return (
      <p className="text-muted-foreground px-2 py-1 text-xs">
        DorkOS could not read your notifications.
      </p>
    );
  }

  if (notifications.length === 0) {
    return <p className="text-muted-foreground px-2 py-1 text-xs">{emptyLabel}</p>;
  }

  return (
    <div className="min-w-0">
      <motion.div variants={staggerContainer} initial="initial" animate="animate">
        {items.map((item) =>
          item.type === 'group' ? (
            <InboxGroupRow
              key={item.id}
              group={item}
              agent={resolveAgent(item.agentId)}
              agentName={getAgentDisplayName(agentsById.get(item.agentId))}
              expanded={expandedGroups.has(groupStateKey(item.agentId, item.kind, item.tone))}
              onToggleExpanded={() =>
                toggleGroup(groupStateKey(item.agentId, item.kind, item.tone))
              }
              onOpenNotification={handleOpen}
            />
          ) : (
            <InboxRow
              key={item.notification.id}
              notification={item.notification}
              agent={resolveAgent(item.notification.agentId)}
              // A row with nowhere to go is not a control — see the class doc.
              onOpen={
                notificationLink(item.notification) === null
                  ? undefined
                  : () => handleOpen(item.notification)
              }
            />
          )
        )}
      </motion.div>

      {hasMore && (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground mt-1 h-7 w-full text-xs"
          onClick={loadMore}
          disabled={isLoadingMore}
        >
          {isLoadingMore ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}
