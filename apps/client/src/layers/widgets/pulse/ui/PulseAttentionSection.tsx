import { useNavigate } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { getPlatform } from '@/layers/shared/lib';
import { useSafePathname } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { useAttentionRows, AttentionSignalRow } from '@/layers/features/dashboard-attention';
import { ScheduleApprovalCard } from '@/layers/features/schedule-approval';
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
 * teaser that can only show five shows the five that matter most. Capability
 * approvals and the prompts agents are parked on are deliberately absent: they
 * live in the header pill, which is on screen beside this panel.
 *
 * "View all →" opens the home surface where the full header and its detail
 * sheets live. Collapses to a calm all-clear line when nothing needs you.
 */
export function PulseAttentionSection() {
  const navigate = useNavigate();
  // "View all" navigates to the home surface. Omit the link when it would be a
  // no-op (already there) and in the router-less Obsidian embed, where there is
  // no home route to reach — an honest omission, not a dead-end button.
  const pathname = useSafePathname();
  const showViewAll = !getPlatform().isEmbedded && pathname !== '/';
  const { schedules, errors, activity, isLoading, total } = useAttentionRows();
  const openActivity = useOpenNotification();

  // One cap across all three groups, spent in draw order.
  const shownSchedules = schedules.slice(0, PULSE_ATTENTION_CAP);
  const shownErrors = errors.slice(0, PULSE_ATTENTION_CAP - shownSchedules.length);
  const shownActivity = activity.slice(
    0,
    PULSE_ATTENTION_CAP - shownSchedules.length - shownErrors.length
  );

  return (
    <PulseSection
      label="Needs attention"
      // Only declare all-clear once the backing queries have loaded — never mid
      // cold-load, which would flash "All quiet" before a row pops in
      // (mirrors PulseActivitySection's loading gate).
      empty={!isLoading && total === 0}
      allClear="All quiet — nothing needs you."
      action={
        showViewAll ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => navigate({ to: '/' })}
          >
            View all →
          </Button>
        ) : undefined
      }
    >
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
