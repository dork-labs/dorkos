/**
 * Approve from anywhere — the approval itself, inside Now, on a phone.
 *
 * **This is the mobile feature the redesign is for.** A permission prompt is
 * the one thing in this product that stops an agent dead, and until now
 * answering one from a phone meant finding the conversation it came from. It
 * lands in Now like every other blocking state (design-decisions §18), and here
 * the card comes with it: allow or deny in place, the route never changes, and
 * the agent moves again (P4 AC-5).
 *
 * **Composed, never copied.** `ApprovalList` is the same stack the pinned home
 * header and the global indicator draw, so a decision looks and behaves the
 * same wherever it is made — including the optimistic checkmark, the focus
 * handoff to the next card, and the refusal toasts. This module decides one
 * thing only: whether there is anything to say.
 *
 * @module widgets/mobile-tabs/ui/MobileNowApprovals
 */
import type { ReactNode } from 'react';
import { usePendingApprovals } from '@/layers/entities/attention';
import { ApprovalList, ApprovalsUnavailable } from '@/layers/features/approvals';

/**
 * What Now should draw above its rows, or `null` for nothing.
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
 * which is the arrangement `ApprovalsIndicator` settled on for the same reason.
 */
export function useNowApprovalsSlot(): ReactNode | null {
  const { approvals, isError, retry } = usePendingApprovals();
  if (!isError && approvals.length === 0) return null;
  return (
    <div data-testid="mobile-now-approvals" className="flex flex-col gap-2 px-2 pt-0.5 pb-1">
      {isError && <ApprovalsUnavailable onRetry={retry} />}
      {approvals.length > 0 && <ApprovalList approvals={approvals} />}
    </div>
  );
}
