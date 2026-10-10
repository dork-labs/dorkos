import { appRoutes } from '@/layers/shared/lib';
import { useNavigate } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';

import {
  useAppStore,
  useIsBelowDesktop,
  usePendingRead,
  useSafePathname,
} from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { describeWaitingQueue, useWaitingQueue } from '@/layers/entities/attention';
import { requestInbox } from '@/layers/entities/notifications';
import { useAttentionRows, AttentionSignalRow } from '@/layers/features/dashboard-attention';
import {
  ScheduleApprovalCard,
  useScheduleApprovalCards,
} from '@/layers/features/schedule-approval';
import { InboxRow, useOpenNotification } from '@/layers/features/inbox';
import { PulseSection } from './PulseSection';

/** Max rows shown in the Pulse teaser (overflow lives on the home surface). */
const PULSE_ATTENTION_CAP = 5;

/**
 * Stagger container that drives the row entrance variants. The rows declare
 * `variants` but no `animate` of their own, so — exactly as the home tab's
 * triage header does — the parent must propagate the `animate` label or the
 * rows would render stuck at their initial (invisible) variant.
 */
const staggerContainer = {
  animate: { transition: { staggerChildren: 0.04 } },
} as const;

/**
 * The "Needs attention" section of the Pulse panel: the top few rows that need
 * the operator, reusing {@link useAttentionRows} and the same row components the
 * home surface draws so there is one implementation and one membership rule.
 *
 * **Blocking first.** A schedule an agent parked and a session that stopped
 * come before what merely went wrong, and the cap is spent in that order — so a
 * teaser that can only show five shows the five that matter most.
 *
 * **What waits in the Inbox is one line here, never a second set of cards.**
 * Capability approvals, the prompts agents are parked on, extensions waiting to
 * be turned on and the decisions extensions ask about are answered in the Inbox
 * popover behind the header pill, so their cards stay there. But they still
 * need the person, so this section reads the SAME queue the pill counts
 * ({@link useWaitingQueue}) and says what is in it, in the pill's own sentence,
 * with a door to it. "Nothing needs you" is only said when that queue is empty
 * too: the pill reading "1 waiting" beside an all-clear was DOR-2578.
 *
 * Parked schedules are left out of the line when they have a card, on purpose:
 * "1 schedule wants your approval" directly above that card says it twice. The
 * ones past the five-row cap have no card, so the line names those. Every item
 * the pill counts still shows here, either as a card or in the line — never
 * neither.
 *
 * A failed read is not an empty queue either: while any of the queue's reads
 * has failed the section says it could not check, never that all is quiet.
 *
 * "View all →" opens the home surface where the full header and its detail
 * sheets live. Collapses to a calm all-clear line when nothing needs you.
 *
 * **Except on the home surface itself with the panel docked beside it, where it
 * draws nothing.** Home's pinned triage header is this same list, from this
 * same model, at full size — and a teaser of what is already on screen beside
 * it is a quarter of the panel spent saying nothing (DOR-1759). That condition
 * is geometry, not just route: below desktop width the panel is a slide-over
 * Sheet that COVERS Home rather than sitting beside it (`RightPanelContainer`),
 * so there the duplicate is not on screen and the section still draws — the
 * person closing the sheet would otherwise find nothing told them
 * anything needed them.
 */
export function PulseAttentionSection() {
  const navigate = useNavigate();
  const pathname = useSafePathname();
  const { schedules, errors, activity, isLoading: isFetchingRows, total } = useAttentionRows();
  const waitingQueue = useWaitingQueue();
  // The panel is a modal sheet everywhere below desktop width
  // (`RightPanelContainer`), not only on a phone. Two rules below read it: the
  // Home de-dup only holds where the panel is DOCKED beside the page, and the
  // Inbox door has to close a sheet before opening over it.
  const panelIsSheet = useIsBelowDesktop();
  // A paused read during the boot-cache restore is not an empty list (DOR-1914).
  // Why `isLoading` cannot answer that on its own is in `usePendingRead`.
  const isLoading = usePendingRead(isFetchingRows || waitingQueue.isLoading);
  const openActivity = useOpenNotification();
  const setRightPanelOpen = useAppStore((state) => state.setRightPanelOpen);

  // A just-approved proposal leaves the server's parked list within a frame,
  // and this panel would swap to its all-clear line over the receipt. The hold
  // keeps it drawn for the beat the card needs (see `settling-approvals`).
  const settlingSchedules = useScheduleApprovalCards(schedules);

  // Beside home's own triage header, this section is that header again. Say
  // nothing — but only where the panel is genuinely BESIDE it: below desktop
  // width (tablet included) the panel is a Sheet that covers Home instead, so the header underneath is not
  // on screen and there is no duplicate to avoid. (Hooks above run either
  // way — the queries are shared with the header, so this costs no extra
  // fetch.)
  const duplicatesHomeHeader = pathname === '/' && !panelIsSheet;
  // One cap across all three groups, spent in draw order.
  const shownSchedules = settlingSchedules.slice(0, PULSE_ATTENTION_CAP);
  const shownErrors = errors.slice(0, PULSE_ATTENTION_CAP - shownSchedules.length);
  const shownActivity = activity.slice(
    0,
    PULSE_ATTENTION_CAP - shownSchedules.length - shownErrors.length
  );
  // The pill's queue, with the schedules that have a card above swapped for the
  // ones the cap pushed off (see the component doc). A schedule still holding
  // its "approved" receipt is not waiting, so only live ones are named.
  const liveScheduleIds = new Set(schedules.map((task) => task.id));
  const overflowSchedules = settlingSchedules
    .slice(PULSE_ATTENTION_CAP)
    .filter((task) => liveScheduleIds.has(task.id));
  const lineQueue = { ...waitingQueue, schedules: overflowSchedules };
  const waitingCount =
    waitingQueue.items.filter((item) => item.kind !== 'schedule-approval').length +
    overflowSchedules.length;
  const unreadable = waitingQueue.isAnyError;

  if (duplicatesHomeHeader) return null;

  return (
    <PulseSection
      label="Needs attention"
      // Only declare all-clear once the backing queries have loaded — never mid
      // cold-load, which would flash "All quiet" before a row pops in
      // (mirrors PulseActivitySection's loading gate).
      // A card still saying it was approved is not an all-clear, even though
      // the server has already stopped counting it.
      // Something waiting in the Inbox is not an all-clear either, whichever
      // kind it is — the same `items` the pill beside this panel counts.
      // And a read that failed is "cannot say", never "nothing".
      empty={
        !isLoading &&
        total === 0 &&
        shownSchedules.length === 0 &&
        waitingCount === 0 &&
        !unreadable
      }
      allClear="All quiet. Nothing needs you."
      action={
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          onClick={() => navigate({ ...appRoutes.home() })}
        >
          View all →
        </Button>
      }
    >
      {/* Said whether or not anything else is drawn: with one read failed, the
          line below may be counting short. */}
      {unreadable && (
        <div
          data-slot="pulse-waiting-unreadable"
          className="mb-2 flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1"
        >
          <span className="text-muted-foreground min-w-0 flex-1 text-xs">
            Couldn’t check everything waiting on you.
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={waitingQueue.retryFailed}
          >
            Try again
          </Button>
        </div>
      )}
      {waitingCount > 0 && (
        <div
          data-slot="pulse-waiting-line"
          className="mb-2 flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1"
        >
          <span className="bg-status-warning size-1.5 shrink-0 rounded-full" aria-hidden />
          <span className="text-foreground/90 min-w-0 flex-1 text-xs">
            {describeWaitingQueue(lineQueue)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={() => {
              // Below desktop this panel is a modal sheet over the page, and
              // the Inbox would open under its overlay: close this one first.
              if (panelIsSheet) setRightPanelOpen(false);
              requestInbox();
            }}
          >
            Open Inbox
          </Button>
        </div>
      )}
      {/* The schedules are CARDS, and sit above the rows in their own presence
          group: `AskCard.Root` declares a hold-and-melt exit, and an exit with
          no `AnimatePresence` watching for it never runs — a decided card would
          vanish under its own receipt. */}
      <AnimatePresence initial={false}>
        {shownSchedules.map((task) => (
          <ScheduleApprovalCard key={task.id} task={task} className="mb-2" />
        ))}
      </AnimatePresence>
      <motion.div variants={staggerContainer} initial="initial" animate="animate">
        {shownErrors.map((signal) => (
          <AttentionSignalRow key={signal.id} signal={signal} />
        ))}
        {shownActivity.map((item) => (
          <InboxRow key={item.id} notification={item} onOpen={() => openActivity(item)} />
        ))}
      </motion.div>
    </PulseSection>
  );
}
