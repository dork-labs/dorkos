import { useNavigate } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { getPlatform } from '@/layers/shared/lib';
import { useIsMobile, useSafePathname } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
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
 * teaser that can only show five shows the five that matter most. Capability
 * approvals and the prompts agents are parked on are deliberately absent: they
 * live in the header pill, which is on screen beside this panel.
 *
 * "View all →" opens the home surface where the full header and its detail
 * sheets live. Collapses to a calm all-clear line when nothing needs you.
 *
 * **Except on the home surface itself with the panel docked beside it, where it
 * draws nothing.** Home's pinned triage header is this same list, from this
 * same model, at full size — and a teaser of what is already on screen beside
 * it is a quarter of the panel spent saying nothing (DOR-1759). That condition
 * is geometry, not just route: on a narrow viewport the panel is a slide-over
 * Sheet that COVERS Home rather than sitting beside it (`RightPanelContainer`),
 * so there the duplicate is not on screen and the section still draws — the
 * mobile person closing the sheet would otherwise find nothing told them
 * anything needed them.
 */
export function PulseAttentionSection() {
  const navigate = useNavigate();
  // "View all" navigates to the home surface. Omitted in the router-less Obsidian
  // embed, where there is no home route to reach — an honest omission, not a
  // dead-end button. On '/' the whole section is gone, so the link has no second
  // way to be a no-op.
  const pathname = useSafePathname();
  const showViewAll = !getPlatform().isEmbedded;
  // The de-dup below only holds when the panel is actually DOCKED beside the
  // page it is de-duping — on a narrow viewport it is a slide-over Sheet that
  // covers Home instead (`RightPanelContainer`), so the duplicate condition
  // never applies there.
  const isMobile = useIsMobile();
  const { schedules, errors, activity, isLoading, total } = useAttentionRows();
  const openActivity = useOpenNotification();

  // A just-approved proposal leaves the server's parked list within a frame,
  // and this panel would swap to its all-clear line over the receipt. The hold
  // keeps it drawn for the beat the card needs (see `settling-approvals`).
  const settlingSchedules = useScheduleApprovalCards(schedules);

  // Beside home's own triage header, this section is that header again. Say
  // nothing — but only where the panel is genuinely BESIDE it: on mobile the
  // panel is a Sheet that covers Home instead, so the header underneath is not
  // on screen and there is no duplicate to avoid. (Hooks above run either
  // way — the queries are shared with the header, so this costs no extra
  // fetch.)
  const duplicatesHomeHeader = pathname === '/' && !isMobile;
  // One cap across all three groups, spent in draw order.
  const shownSchedules = settlingSchedules.slice(0, PULSE_ATTENTION_CAP);
  const shownErrors = errors.slice(0, PULSE_ATTENTION_CAP - shownSchedules.length);
  const shownActivity = activity.slice(
    0,
    PULSE_ATTENTION_CAP - shownSchedules.length - shownErrors.length
  );

  if (duplicatesHomeHeader) return null;

  return (
    <PulseSection
      label="Needs attention"
      // Only declare all-clear once the backing queries have loaded — never mid
      // cold-load, which would flash "All quiet" before a row pops in
      // (mirrors PulseActivitySection's loading gate).
      // A card still saying it was approved is not an all-clear, even though
      // the server has already stopped counting it.
      empty={!isLoading && total === 0 && shownSchedules.length === 0}
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
