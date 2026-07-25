import { AnimatePresence, motion } from 'motion/react';
import { usePendingApprovals } from '../model/use-pending-approvals';
import { ApprovalList } from './ApprovalList';
import { ApprovalsUnavailable } from './ApprovalsUnavailable';

const conditionalSection = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { duration: 0.25, ease: [0, 0, 0.2, 1] },
} as const;

/** The section heading, shared by the waiting and the cannot-read states. */
function SectionHeading() {
  return (
    <h2 className="text-status-warning-fg mb-3 text-xs font-medium tracking-widest uppercase">
      Waiting On You
    </h2>
  );
}

/**
 * The dashboard section that holds every approval waiting on you.
 *
 * Renders zero DOM when nothing is waiting — no reassurance text, no empty box.
 * It animates in when an agent asks for something and out again the moment the
 * last request is answered.
 *
 * This is the dashboard's copy of the queue, not the only way to reach it: the
 * app header carries the same cards on every route (widgets/approvals-indicator),
 * because an agent asks while a person is wherever they happen to be.
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
        <SectionHeading />
        <ApprovalsUnavailable onRetry={retry} />
      </section>
    );
  }

  return (
    <AnimatePresence initial={false}>
      {approvals.length > 0 && (
        <motion.section key="approvals" {...conditionalSection} className="overflow-hidden">
          <SectionHeading />
          <ApprovalList approvals={approvals} />
        </motion.section>
      )}
    </AnimatePresence>
  );
}
