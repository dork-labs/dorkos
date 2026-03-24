import { Loader2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

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
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="mb-1 flex items-center gap-2 text-xs text-blue-400"
        >
          <Loader2 className="size-(--size-icon-xs) shrink-0 animate-spin" />
          <span className="truncate">{activeForm}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
