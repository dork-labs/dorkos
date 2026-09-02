import { useCallback, useMemo, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { useSettlingApprovals } from '../model/settling-approvals';
import { ApprovalCard } from './ApprovalCard';

const staggerContainer = {
  animate: { transition: { staggerChildren: 0.04 } },
} as const;

/** Never show more cards at once than a person can actually work through. */
const MAX_CARDS = 6;

export interface ApprovalListProps {
  /** Approvals waiting on a decision, oldest first. */
  approvals: PendingApproval[];
}

/**
 * The stack of approval cards, shared by every surface that shows them: the
 * pinned home header and the global indicator both render this, so a person
 * sees the same card and the same answer buttons wherever they decide.
 *
 * Long queues are capped rather than endless, but the cap is stated: a hidden
 * seventh request is an agent blocked with no way for anyone to know.
 *
 * Answered cards leave under `AnimatePresence`, which is what keeps a card on
 * screen holding its checkmark after the data has already dropped it — see
 * `approvalExitTransition`.
 *
 * @param props - The waiting {@link ApprovalListProps.approvals}.
 */
export function ApprovalList({ approvals }: ApprovalListProps) {
  // **The cap counts requests, not cards.** A card still saying how it was
  // answered is not queueing for anything, so spending a slot on it would push
  // a genuinely waiting request out of view, and counting it in the line below
  // would report "1 more request is waiting" when nothing is. Both were true
  // the moment the settling hold started merging answered cards back into this
  // list (DOR-1411 review): with seven waiting, answering one left six live
  // plus one held, the slice cut the receipt, and the footer lied about it.
  const held = useSettlingApprovals();
  const { shown, hidden } = useMemo(() => {
    if (held.length === 0) {
      return {
        shown: approvals.slice(0, MAX_CARDS),
        hidden: Math.max(0, approvals.length - MAX_CARDS),
      };
    }
    const heldIds = new Set(held.map((approval) => approval.approvalId));
    const waiting = approvals.filter((approval) => !heldIds.has(approval.approvalId));
    const answered = approvals.filter((approval) => heldIds.has(approval.approvalId));
    return {
      // Receipts last, which is where the merge put them anyway, and always
      // drawn: they leave on their own timer a beat from now.
      shown: [...waiting.slice(0, MAX_CARDS), ...answered],
      hidden: Math.max(0, waiting.length - MAX_CARDS),
    };
  }, [approvals, held]);
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * Put focus somewhere real when a card is answered.
   *
   * The answer replaces the buttons with a checkmark, so the element the reader
   * was standing on stops existing — and focus falls to the body, which is
   * nowhere. It goes to the next card's Allow instead, or to the list itself
   * when that was the last thing left to answer.
   *
   * Deferred by a tick for the same reason the context menu defers its restore:
   * at click time the swap has not rendered, so the next card's button is only
   * findable afterwards.
   */
  const handleDecided = useCallback((approvalId: string) => {
    setTimeout(() => {
      const list = listRef.current;
      if (!list) return;
      const cards = Array.from(list.querySelectorAll<HTMLElement>('[data-approval-id]'));
      const answered = cards.findIndex((card) => card.dataset.approvalId === approvalId);
      for (const card of cards.slice(answered + 1)) {
        const next = card.querySelector<HTMLElement>('[data-slot="approval-allow"]');
        if (next) {
          next.focus();
          return;
        }
      }
      list.focus();
    }, 0);
  }, []);

  return (
    <motion.div
      ref={listRef}
      // Focusable as a landing place, never in the tab order: it is where focus
      // goes when the card just answered was the last answerable one.
      tabIndex={-1}
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="flex flex-col gap-2 outline-none"
    >
      <AnimatePresence initial={false}>
        {shown.map((approval) => (
          <ApprovalCard key={approval.approvalId} approval={approval} onDecided={handleDecided} />
        ))}
      </AnimatePresence>
      {hidden > 0 && (
        <p className="text-muted-foreground text-xs">
          {hidden === 1
            ? '1 more request is waiting. Answer one of these to see it.'
            : `${hidden} more requests are waiting. Answer some of these to see them.`}
        </p>
      )}
    </motion.div>
  );
}
