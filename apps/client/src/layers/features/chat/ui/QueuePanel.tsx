import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { QueueItem } from '../model/use-message-queue';

interface QueuePanelProps {
  queue: QueueItem[];
  editingIndex: number | null;
  onEdit: (index: number) => void;
  onRemove: (index: number) => void;
}

const staggerContainer = {
  animate: {
    transition: { staggerChildren: 0.05 },
  },
};

const staggerChild = {
  initial: { opacity: 0, y: -4 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { type: 'spring' as const, stiffness: 320, damping: 28 },
  },
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.15 } },
};

/** Inline queue card list rendered above the chat textarea. */
export function QueuePanel({ queue, editingIndex, onEdit, onRemove }: QueuePanelProps) {
  if (queue.length === 0) return null;

  return (
    <AnimatePresence mode="popLayout">
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        transition={{ duration: 0.2 }}
        className="mb-1.5 overflow-hidden"
        layout
      >
        <div className="text-muted-foreground mb-1 text-xs font-medium">
          Queued ({queue.length})
        </div>
        <motion.div
          variants={staggerContainer}
          initial="initial"
          animate="animate"
          className="space-y-0.5"
        >
          <AnimatePresence mode="popLayout">
            {queue.map((item, i) => (
              <motion.div
                key={item.id}
                variants={staggerChild}
                exit={staggerChild.exit}
                layout
              >
                <button
                  type="button"
                  onClick={() => onEdit(i)}
                  className={cn(
                    'group flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors',
                    editingIndex === i
                      ? 'border-primary bg-muted border-l-2'
                      : 'hover:bg-muted/50'
                  )}
                >
                  <span className="text-muted-foreground shrink-0 text-xs font-medium">
                    {i + 1}.
                  </span>
                  <span className="text-muted-foreground line-clamp-1 flex-1 text-sm">
                    {item.content}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(i);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                        e.preventDefault();
                        onRemove(i);
                      }
                    }}
                    className="text-muted-foreground hover:text-foreground shrink-0 rounded-sm p-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100"
                    aria-label={`Remove queued message ${i + 1}`}
                  >
                    <X className="size-3" />
                  </span>
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
