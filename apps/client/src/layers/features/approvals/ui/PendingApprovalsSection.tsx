import { AnimatePresence, motion } from 'motion/react';
import { usePendingApprovals } from '../model/use-pending-approvals';
import { ApprovalCard } from './ApprovalCard';

const conditionalSection = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { duration: 0.25, ease: [0, 0, 0.2, 1] },
} as const;

const staggerContainer = {
  animate: { transition: { staggerChildren: 0.04 } },
} as const;

/** Never show more cards than a person can actually work through at once. */
const MAX_CARDS = 6;

/**
 * The dashboard section that holds every approval waiting on you.
 *
 * Renders zero DOM when nothing is waiting — no reassurance text, no empty box.
 * It animates in when an agent asks for something and out again the moment the
 * last request is answered.
 */
export function PendingApprovalsSection() {
  const { approvals } = usePendingApprovals();

  return (
    <AnimatePresence initial={false}>
      {approvals.length > 0 && (
        <motion.section key="approvals" {...conditionalSection} className="overflow-hidden">
          <h2 className="mb-3 text-xs font-medium tracking-widest text-amber-600 uppercase dark:text-amber-500">
            Waiting On You
          </h2>
          <motion.div
            variants={staggerContainer}
            initial="initial"
            animate="animate"
            className="flex flex-col gap-2"
          >
            {approvals.slice(0, MAX_CARDS).map((approval) => (
              <ApprovalCard key={approval.approvalId} approval={approval} />
            ))}
          </motion.div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
