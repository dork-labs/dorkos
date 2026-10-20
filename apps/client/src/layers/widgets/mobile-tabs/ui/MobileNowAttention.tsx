/**
 * Answer from anywhere — an approval or a question, at the top of Home, on a
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
 * **Two kinds of blockage, one place.** A capability approval and an Ask
 * (question, elicitation, or a permission prompt raised outside a session) are
 * different objects on the wire, but they are the same thing to the person
 * being asked, so this widget draws both. The prompts go first — their window
 * is ten minutes against a capability approval's two hours, so drawing them
 * first IS time-left order, the same reasoning `InboxBell` (the
 * header's tray) already settled on.
 *
 * **Composed, never copied.** `AskList` and `ApprovalList` are the exact stacks
 * the header tray and the home triage header draw, so a decision
 * looks and behaves the same wherever it is made — including the optimistic
 * checkmark, the countdown, and the answer plumbing. This module decides one
 * thing only: whether there is anything to say.
 *
 * @module widgets/mobile-tabs/ui/MobileNowAttention
 */
import { type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  useAskAgentNames,
  usePendingApprovals,
  usePendingInteractions,
  useSettlingAsks,
} from '@/layers/entities/attention';
import { AskList } from '@/layers/features/ask';
import { ApprovalList, ApprovalsUnavailable, useApprovalCards } from '@/layers/features/approvals';
import { toSession } from '@/layers/shared/lib';

/** What {@link useNowAttentionSlot} hands the phone's Home tab. */
export interface NowAttentionSlot {
  /** The cards, or `null` when there is nothing to say. */
  slot: ReactNode | null;
  /**
   * How many things these cards are waiting on you for — the Home badge's
   * number, and the one the phone announces. Receipts are not counted: a
   * settled Ask is not waiting on anybody.
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
  const agentNames = useAskAgentNames(asks);
  const navigate = useNavigate();

  const count = approvals.length + asks.length;

  const nothingToSay =
    !isError && shownApprovals.length === 0 && asks.length === 0 && settling.length === 0;
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
      </div>
    ),
  };
}
