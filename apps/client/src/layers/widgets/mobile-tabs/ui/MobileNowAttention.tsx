/**
 * Answer from anywhere — everything waiting on you, at the top of Home, on a
 * phone.
 *
 * **This is the mobile feature the cockpit is for.** A permission prompt or a
 * question is the one thing in this product that stops an agent dead, and
 * answering one from a phone used to mean finding the conversation it came
 * from. Here the card comes to you: allow, deny, skip or answer in place, the
 * route never changes, and the agent moves again (P4 AC-5).
 *
 * **Why the phone keeps these when the sidebar lists only places.** They are
 * the Inbox's own cards, not sidebar rows — and on a phone the raised panel
 * covers the header the Inbox lives in, so this is the Inbox, drawn where the
 * phone can see it.
 *
 * **Every blockage, one place.** A capability approval, an Ask (question,
 * elicitation, or a permission prompt raised outside a session) and a schedule
 * an agent proposed are different objects on the wire, but they are the same
 * thing to the person being asked, so this widget draws all three as the
 * Inbox's own cards. The prompts go first — their window is ten minutes
 * against a capability approval's two hours, so drawing them first IS
 * time-left order, the same reasoning `InboxBell` (the header's tray) already
 * settled on. Whatever `useAttentionSignals` still holds after that — a chat
 * that failed, a session blocked on a prompt that has not reached the list yet
 * — is a row that opens where it is (the sidebar's old Heads up rows, which
 * this replaces on a phone).
 *
 * **Composed, never copied.** `AskList` and `ApprovalList` are the exact stacks
 * the header tray and the home triage header draw, so a decision
 * looks and behaves the same wherever it is made — including the optimistic
 * checkmark, the countdown, and the answer plumbing. This module decides one
 * thing only: whether there is anything to say.
 *
 * @module widgets/mobile-tabs/ui/MobileNowAttention
 */
import { useMemo, type ReactNode } from 'react';
import { AnimatePresence } from 'motion/react';
import { useNavigate } from '@tanstack/react-router';
import {
  approvalSignalId,
  interactionSignalId,
  useAskAgentNames,
  useAttentionSignals,
  usePendingApprovals,
  usePendingInteractions,
  usePendingScheduleApprovals,
  useSettlingAsks,
} from '@/layers/entities/attention';
import { AskList } from '@/layers/features/ask';
import { ApprovalList, ApprovalsUnavailable, useApprovalCards } from '@/layers/features/approvals';
import { AttentionSignalRow } from '@/layers/features/dashboard-attention';
import {
  ScheduleApprovalCard,
  useScheduleApprovalCards,
} from '@/layers/features/schedule-approval';
import { toSession } from '@/layers/shared/lib';

/** What {@link useNowAttentionSlot} hands the phone's Home tab. */
export interface NowAttentionSlot {
  /** The cards, or `null` when there is nothing to say. */
  slot: ReactNode | null;
  /**
   * How many things are waiting on you — the Home badge's number, and the one
   * the phone announces. It counts exactly what Home draws: every approval,
   * question and proposed schedule, plus each row below them. Read off the
   * pending lists rather than `useAttentionSignals().length`, because a prompt
   * from a session outside the recent window has no signal and still has a
   * card. Receipts are not counted: a settled Ask is not waiting on anybody.
   */
  count: number;
}

/**
 * What Home should draw above its list, and how much of it is waiting on you.
 *
 * A hook returning a node rather than a component, because the caller has to
 * know the difference between "nothing" and "something": a failed read with
 * nothing pending is still something to say.
 *
 * **The failure is loud even while stale cards are on screen.** A refetch that
 * fails while yesterday's list is still cached would otherwise show cards that
 * may already be answered with nothing saying so; the notice sits above them,
 * which is the arrangement `InboxBell` settled on for the same reason.
 * The pending-Ask read carries no such failure state of its own today — no
 * surface in the cockpit shows one yet — so this stays silent about it rather
 * than inventing an error state the rest of the product does not have.
 */
export function useNowAttentionSlot(): NowAttentionSlot {
  const { approvals, isError, retry } = usePendingApprovals();
  const { interactions: asks } = usePendingInteractions();
  // Answered Asks, still on screen saying how they ended. Without this,
  // answering the LAST pending Ask unmounts this whole slot in the same frame
  // its receipt would draw — the disappearance the header pill's own
  // `InboxBell` and the home triage header's `PinnedTriageHeaderView`
  // both guard against the same way: hold the slot, and the AskList render,
  // open for as long as anything is settling.
  const settling = useSettlingAsks();
  // The same hold for the approvals themselves (DOR-1411). Answering the last
  // one drops it from the pending list on the next refetch, and `nothingToSay`
  // below then unmounts this whole slot in the frame its receipt would draw.
  const shownApprovals = useApprovalCards(approvals);
  const { schedules } = usePendingScheduleApprovals();
  // The same hold for a decided schedule, so its receipt is read before the
  // card leaves.
  const shownSchedules = useScheduleApprovalCards(schedules);
  const agentNames = useAskAgentNames(asks);
  const signals = useAttentionSignals();
  const navigate = useNavigate();

  // What no card above draws: a failed chat, or a session blocked on a prompt
  // that has not reached the pending list yet. Matched on the signal ids the
  // cards' own objects mint, through the functions that decide the format.
  const rows = useMemo(() => {
    const covered = new Set([
      ...approvals.map((approval) => approvalSignalId(approval.approvalId)),
      ...asks.map((ask) => interactionSignalId(ask.interaction.id)),
    ]);
    return signals.filter(
      (signal) => signal.kind !== 'schedule-approval' && !covered.has(signal.id)
    );
  }, [signals, approvals, asks]);

  const count = approvals.length + asks.length + schedules.length + rows.length;

  const nothingToSay =
    !isError &&
    shownApprovals.length === 0 &&
    asks.length === 0 &&
    settling.length === 0 &&
    shownSchedules.length === 0 &&
    rows.length === 0;
  if (nothingToSay) return { slot: null, count };

  return {
    count,
    slot: (
      <div data-testid="mobile-now-attention" className="flex flex-col gap-2 px-2 pt-0.5 pb-1">
        {isError && <ApprovalsUnavailable onRetry={retry} />}
        {(asks.length > 0 || settling.length > 0) && (
          <AskList
            asks={asks}
            agentNames={agentNames}
            // Home is not a popover to escape on the way there — the panel stays
            // up, `onBeforeLoad` lowers it, and the route lands on the
            // conversation the question came from.
            onOpenSession={(sessionId) => {
              void navigate(toSession({ session: sessionId }));
            }}
          />
        )}
        {shownApprovals.length > 0 && <ApprovalList approvals={shownApprovals} />}
        {/* `AnimatePresence` keeps a decided card mounted long enough to say
            so, as the Inbox's own schedule group does. */}
        <AnimatePresence initial={false}>
          {shownSchedules.map((task) => (
            <ScheduleApprovalCard key={task.id} task={task} />
          ))}
        </AnimatePresence>
        {rows.length > 0 && (
          <div data-testid="mobile-now-rows" className="flex flex-col">
            {rows.map((signal) => (
              <AttentionSignalRow key={signal.id} signal={signal} />
            ))}
          </div>
        )}
      </div>
    ),
  };
}
