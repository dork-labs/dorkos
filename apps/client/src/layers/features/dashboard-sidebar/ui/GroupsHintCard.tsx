import { motion } from 'motion/react';
import { FolderPlus, X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

interface GroupsHintCardProps {
  /** Open the inline group-create flow. */
  onNewGroup: () => void;
  /** Dismiss the hint for good (persists `groupsHintDismissed`). */
  onDismiss: () => void;
}

/**
 * A one-time, dismissible nudge shown once a fleet is large enough to benefit
 * from grouping (the orchestrator gates it on ≥8 agents, no groups yet, and
 * not previously dismissed). It points at the "New group" action and never
 * returns once dismissed.
 */
export function GroupsHintCard({ onNewGroup, onDismiss }: GroupsHintCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0, 0, 0.2, 1] } }}
      exit={{ opacity: 0, y: -6, transition: { duration: 0.15 } }}
      className="border-sidebar-border bg-sidebar-accent/40 relative mt-1 rounded-lg border p-3"
    >
      <button
        type="button"
        aria-label="Dismiss grouping tip"
        onClick={onDismiss}
        className={cn(
          'text-muted-foreground hover:text-foreground focus-visible:ring-sidebar-ring',
          'absolute top-2 right-2 flex size-5 items-center justify-center rounded-md outline-hidden focus-visible:ring-2'
        )}
      >
        <X className="size-3.5" />
      </button>
      <p className="text-sidebar-foreground pr-5 text-xs font-medium">Group your agents</p>
      <p className="text-muted-foreground mt-1 text-xs">
        Sort your agents into named groups — by project, client, or however you think about them.
      </p>
      <button
        type="button"
        onClick={onNewGroup}
        className={cn(
          'text-sidebar-foreground hover:bg-sidebar-accent focus-visible:ring-sidebar-ring',
          'mt-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium outline-hidden focus-visible:ring-2'
        )}
      >
        <FolderPlus className="size-3.5" />
        New group
      </button>
    </motion.div>
  );
}
