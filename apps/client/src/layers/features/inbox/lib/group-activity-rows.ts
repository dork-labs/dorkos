/**
 * Folding consecutive same-agent, same-kind runs of three or more into one
 * collapsible group row (spec `schedule-approval-experience` task C3).
 *
 * Pure, over whatever page of notifications the caller already holds — it
 * never asks for more and never trims what paging or SSE handed it. Nothing
 * here touches the Inbox's cache: paging, the 50-row live cap and cursor
 * invariants stay entirely `entities/notifications/model/notification-cache`'s
 * job. This is a presentation-layer RESHAPE of an already-fetched list, run
 * again on every render the list changes — which is also why grouping a
 * longer list after "Load more" just grows or adds groups rather than needing
 * its own state.
 *
 * @module features/inbox/lib/group-activity-rows
 */
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import {
  isGroupableKind,
  notificationRowTone,
  type GroupableNotificationKind,
  type NotificationTone,
} from '@/layers/entities/notifications';

/**
 * A run shorter than this stays as individual rows — coalescing two events
 * saves no scanning and costs the reader a click to see what happened.
 */
export const MIN_BURST_SIZE = 3;

/** One notification, drawn on its own row. */
export interface InboxRowItem {
  type: 'row';
  notification: NotificationDTO;
}

/**
 * Three or more consecutive same-agent, same-kind, same-tone rows, folded
 * into one collapsible header.
 */
export interface InboxGroupItem {
  type: 'group';
  /**
   * A React key stable across a render where a LIVE ARRIVAL grew the group:
   * the OLDEST member's id, not the newest. An SSE arrival prepends to the
   * front of the source list, which grows the run from the front too — under
   * that one kind of growth, the run's last element never moves.
   *
   * **Not stable across everything, and expand state does not lean on it.**
   * "Load more" can grow a run BACKWARD (older rows join from the tail), and
   * the live cap can trim rows off the tail too — both change who the oldest
   * member is. A component keyed on this id would silently re-collapse an
   * open group the moment either happened (caught in review), so
   * `InboxList` does not: it tracks which groups are expanded itself, keyed
   * by {@link groupStateKey} — the streak's own identity — rather than by
   * this id. This field exists only to give React a reconciliation key
   * that avoids pointless remounts on the common (SSE) case.
   */
  id: string;
  agentId: string;
  kind: GroupableNotificationKind;
  tone: NotificationTone;
  /** Newest first — the same order the source list held them in. */
  notifications: readonly NotificationDTO[];
}

/**
 * The STABLE identity of a group's expand/collapse state — semantic, not
 * positional. {@link InboxGroupItem.id} changes shape as a run's membership
 * changes (`Load more` extending it backward, the live cap trimming its
 * tail), which is exactly wrong for UI state a person just set. `agentId`,
 * `kind` and `tone` together name the STREAK itself, and neither kind of
 * membership change touches any of the three.
 *
 * @param agentId - The group's agent.
 * @param kind - The group's kind.
 * @param tone - The group's tone.
 */
export function groupStateKey(
  agentId: string,
  kind: GroupableNotificationKind,
  tone: NotificationTone
): string {
  return `${agentId}:${kind}:${tone}`;
}

/** What {@link groupActivityRows} hands back, in source order. */
export type InboxListItem = InboxRowItem | InboxGroupItem;

/**
 * Fold consecutive runs sharing `agentId`, `kind` AND tone into groups of
 * three or more; a run of one or two stays individual rows, a notification
 * with no `agentId` is never grouped at all — there is no "who" for the
 * group's headline to name — and neither is one whose kind can never carry
 * an `agentId` in the first place (see {@link isGroupableKind}).
 *
 * **Tone joins the key on purpose.** `run.completed` carries both a success
 * and a failure under one kind, distinguished only by tier — folding tone
 * into the run boundary is what stops a burst of successful runs swallowing
 * the one that failed into an innocent-looking "finished 6 runs". Every other
 * kind's tone is constant per kind, so this costs those bursts nothing.
 *
 * @param notifications - The fetched page, newest first — whatever
 *   `useNotifications` already holds.
 */
export function groupActivityRows(notifications: readonly NotificationDTO[]): InboxListItem[] {
  const items: InboxListItem[] = [];
  let i = 0;

  while (i < notifications.length) {
    const first = notifications[i];
    const agentId = first.agentId;

    if (agentId === undefined || !isGroupableKind(first.kind)) {
      items.push({ type: 'row', notification: first });
      i += 1;
      continue;
    }

    const tone = notificationRowTone(first);
    let j = i + 1;
    while (
      j < notifications.length &&
      notifications[j].agentId === agentId &&
      notifications[j].kind === first.kind &&
      notificationRowTone(notifications[j]) === tone
    ) {
      j += 1;
    }

    const run = notifications.slice(i, j);
    if (run.length >= MIN_BURST_SIZE) {
      items.push({
        type: 'group',
        id: run[run.length - 1].id,
        agentId,
        kind: first.kind,
        tone,
        notifications: run,
      });
    } else {
      for (const notification of run) items.push({ type: 'row', notification });
    }
    i = j;
  }

  return items;
}
