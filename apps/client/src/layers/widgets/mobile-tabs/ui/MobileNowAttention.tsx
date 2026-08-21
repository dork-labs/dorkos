/**
 * Answer from anywhere — an approval or a question, inside Now, on a phone.
 *
 * **This is the mobile feature the redesign is for.** A permission prompt or a
 * question is the one thing in this product that stops an agent dead, and
 * until now answering one from a phone meant finding the conversation it came
 * from. Both land in Now like every other blocking state (design-decisions
 * §18), and here the card comes with them: allow, deny, skip or answer in
 * place, the route never changes, and the agent moves again (P4 AC-5).
 *
 * **Two kinds of blockage, one zone.** A capability approval and an Ask
 * (question, elicitation, or a permission prompt raised outside a session) are
 * different objects on the wire, but they are the same thing to the person
 * being asked, so this widget draws both. The prompts go first — their window
 * is ten minutes against a capability approval's two hours, so drawing them
 * first IS time-left order, the same reasoning `InboxBell` (the
 * header's tray) already settled on.
 *
 * **Composed, never copied.** `AskList` and `ApprovalList` are the exact stacks
 * the header tray, the sidebar and the home triage header draw, so a decision
 * looks and behaves the same wherever it is made — including the optimistic
 * checkmark, the countdown, and the answer plumbing. This module decides one
 * thing only: whether there is anything to say.
 *
 * @module widgets/mobile-tabs/ui/MobileNowAttention
 */
import { useMemo, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  approvalSignalId,
  interactionSignalId,
  useAskAgentNames,
  usePendingApprovals,
  usePendingInteractions,
  useSettlingAsks,
} from '@/layers/entities/attention';
import { AskList } from '@/layers/features/ask';
import { ApprovalList, ApprovalsUnavailable } from '@/layers/features/approvals';

/** Nothing covered — one shared array, so an empty slot never rebuilds the model. */
const NOTHING_COVERED: readonly string[] = [];

/** What {@link useNowAttentionSlot} hands the phone's Home tab. */
export interface NowAttentionSlot {
  /** The cards, or `null` when there is nothing to say. */
  slot: ReactNode | null;
  /**
   * The signal ids these cards cover, for the sidebar model's Heads up rows.
   *
   * **This is the whole of the "one blockage, one place" rule** (DOR-1391): the
   * cards below and the Now rows underneath them were drawing the same
   * approvals and the same prompts, so a single blocked agent appeared twice in
   * one viewport. The ids are built through {@link approvalSignalId} and
   * {@link interactionSignalId} — the same functions `deriveAttentionSignals`
   * itself calls — because that is what the model matches on, and a
   * hand-spelled copy of the format is a copy that can drift from it.
   *
   * A blocked session whose prompt has not arrived yet keeps its row, and
   * correctly: its signal is `blocked:<sessionId>`, no card here covers it, and
   * the row is the only thing telling anybody it is waiting.
   */
  coveredSignalIds: readonly string[];
}

/**
 * What Now should draw above its rows, and which blockages that covers.
 *
 * A hook returning a node rather than a component, because the caller has to
 * know the difference between "nothing" and "something": a non-null slot brings
 * the Now zone into existence when the model has none, and that is exactly the
 * failure case — no approvals were read, so none of them became a Now row, so
 * without this there is no zone in which to say the read failed.
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
  const agentNames = useAskAgentNames(asks);
  const navigate = useNavigate();

  // Memoized because it feeds the sidebar model's snapshot, where a fresh array
  // per render would rebuild the whole panel on every activity event (spec §H).
  // Receipts are not covered: a settled Ask has no signal left to hide.
  const coveredSignalIds = useMemo(
    () => [
      ...approvals.map((approval) => approvalSignalId(approval.approvalId)),
      ...asks.map((ask) => interactionSignalId(ask.interaction.id)),
    ],
    [approvals, asks]
  );

  const nothingToSay =
    !isError && approvals.length === 0 && asks.length === 0 && settling.length === 0;
  if (nothingToSay) return { slot: null, coveredSignalIds: NOTHING_COVERED };

  return {
    coveredSignalIds,
    slot: (
      <div data-testid="mobile-now-attention" className="flex flex-col gap-2 px-2 pt-0.5 pb-1">
        {isError && <ApprovalsUnavailable onRetry={retry} />}
        {(asks.length > 0 || settling.length > 0) && (
          <AskList
            asks={asks}
            agentNames={agentNames}
            // Home is not a popover to escape on the way there — the panel stays
            // up, `onBeforeLoad` lowers it, and the route lands on the same
            // conversation a tap on any other Now row would open.
            onOpenSession={(sessionId) => {
              void navigate({ to: '/session', search: { session: sessionId } });
            }}
          />
        )}
        {approvals.length > 0 && <ApprovalList approvals={approvals} />}
      </div>
    ),
  };
}
