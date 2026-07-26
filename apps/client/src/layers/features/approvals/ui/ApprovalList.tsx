import { motion } from 'motion/react';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
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
 * dashboard section and the global indicator both render this, so a person sees
 * the same card and the same answer buttons wherever they decide.
 *
 * Long queues are capped rather than endless, but the cap is stated: a hidden
 * seventh request is an agent blocked with no way for anyone to know.
 *
 * @param props - The waiting {@link ApprovalListProps.approvals}.
 */
export function ApprovalList({ approvals }: ApprovalListProps) {
  const hidden = Math.max(0, approvals.length - MAX_CARDS);

  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="flex flex-col gap-2"
    >
      {approvals.slice(0, MAX_CARDS).map((approval) => (
        <ApprovalCard key={approval.approvalId} approval={approval} />
      ))}
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
