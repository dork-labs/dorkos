import { AnimatePresence, motion } from 'motion/react';
import { Button } from '@/layers/shared/ui';
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
 *
 * A failed read is the one case that must NOT look like silence: an agent can be
 * stuck waiting on a person who is being shown an empty dashboard. So a read error
 * says so, and offers to try again.
 */
export function PendingApprovalsSection() {
  const { approvals, isError, retry } = usePendingApprovals();

  if (isError && approvals.length === 0) {
    return (
      <section>
        <h2 className="mb-3 text-xs font-medium tracking-widest text-amber-600 uppercase dark:text-amber-500">
          Waiting On You
        </h2>
        <div
          data-slot="approvals-error"
          className="bg-background/60 flex min-w-0 flex-col gap-2 rounded-lg border border-amber-500/20 p-3 sm:flex-row sm:items-center"
        >
          <p className="text-muted-foreground min-w-0 flex-1 text-xs">
            DorkOS could not check whether anything is waiting for your approval. An agent may be
            paused.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 px-2.5 text-xs"
            onClick={retry}
          >
            Try again
          </Button>
        </div>
      </section>
    );
  }

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
