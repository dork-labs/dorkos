import { AnimatePresence, motion } from 'motion/react';
import { COLLAPSE_TRANSITION, COLLAPSE_VARIANTS } from '@/layers/shared/lib';
import { Spinner } from '@/layers/shared/ui';

interface TaskActiveFormProps {
  activeForm: string | null;
  isCollapsed: boolean;
}

/** Animated spinner showing the currently active task form name. */
export function TaskActiveForm({ activeForm, isCollapsed }: TaskActiveFormProps) {
  return (
    <AnimatePresence>
      {activeForm && !isCollapsed && (
        <motion.div
          variants={COLLAPSE_VARIANTS}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={COLLAPSE_TRANSITION}
          className="mb-1 flex items-center gap-2 text-xs text-blue-400"
        >
          <Spinner size="xs" className="shrink-0" />
          <span className="truncate">{activeForm}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
