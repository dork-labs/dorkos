import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { QueueItem } from '../../model/use-message-queue';

interface QueuePanelProps {
  queue: QueueItem[];
  editingIndex: number | null;
  /** Called with the item's stable id — positions shift when the queue auto-flushes. */
  onEdit: (id: string) => void;
  /** Called with the item's stable id — positions shift when the queue auto-flushes. */
  onRemove: (id: string) => void;
}

/**
 * Inline queue card list rendered above the chat textarea.
 *
 * Each row is a plain container holding two sibling buttons — edit and remove.
 * Nesting the remove control inside the edit button would be invalid HTML, so
 * browsers handle it inconsistently and assistive tech only ever sees one
 * control.
 */
export function QueuePanel({ queue, editingIndex, onEdit, onRemove }: QueuePanelProps) {
  if (queue.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2 }}
      className="mb-1.5 overflow-hidden"
    >
      <div className="text-muted-foreground mb-1 text-xs font-medium">Queued ({queue.length})</div>
      <div className="space-y-0.5">
        <AnimatePresence mode="popLayout">
          {queue.map((item, i) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: -4 }}
              animate={{
                opacity: 1,
                y: 0,
                transition: { type: 'spring', stiffness: 320, damping: 28 },
              }}
              exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
              layout
            >
              <div
                className={cn(
                  'group flex w-full items-center gap-1 rounded-md pr-2 transition-colors',
                  editingIndex === i ? 'border-primary bg-muted border-l-2' : 'hover:bg-muted/50'
                )}
              >
                <button
                  type="button"
                  onClick={() => onEdit(item.id)}
                  aria-current={editingIndex === i ? true : undefined}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-3 text-left"
                >
                  <span className="text-muted-foreground shrink-0 text-xs font-medium">
                    {i + 1}.
                  </span>
                  <span className="text-muted-foreground line-clamp-1 flex-1 text-sm">
                    {item.content}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(item.id)}
                  className="text-muted-foreground hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-sm opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                  aria-label={`Remove queued message ${i + 1}`}
                >
                  <X className="size-3" />
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
