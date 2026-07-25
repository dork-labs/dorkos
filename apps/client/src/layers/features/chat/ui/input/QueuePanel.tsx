import { AnimatePresence, motion } from 'motion/react';
import { X, CornerDownLeft } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { QueueItem } from '../../model/use-message-queue';

interface QueuePanelProps {
  queue: QueueItem[];
  editingIndex: number | null;
  /** Called with the item's stable id — positions shift when the queue auto-flushes. */
  onEdit: (id: string) => void;
  /** Called with the item's stable id — positions shift when the queue auto-flushes. */
  onRemove: (id: string) => void;
  /** Send this message now, ahead of the queue. Called with the item's stable id. */
  onSend: (id: string) => void;
  /**
   * Why Send-now cannot happen right now, or `null` when it can. Shown as the
   * disabled control's title so the refusal always says why.
   */
  sendBlockedReason: string | null;
}

/**
 * Inline queue card list rendered above the chat textarea.
 *
 * Each row is a plain container holding sibling buttons — edit, send-now, and
 * remove. Nesting them inside the edit button would be invalid HTML, so
 * browsers handle it inconsistently and assistive tech only ever sees one
 * control.
 *
 * Send-now is what keeps a queued message from ever being trapped (DOR-480). The
 * auto-flush pump only arms on the streaming→idle edge, so a turn that ended in
 * failure — or any lock race that put a message back — used to leave the queue
 * frozen with no way out but Edit-then-Remove, which threw the text away. When a
 * send genuinely cannot happen the control is disabled and says why, rather than
 * doing nothing.
 */
export function QueuePanel({
  queue,
  editingIndex,
  onEdit,
  onRemove,
  onSend,
  sendBlockedReason,
}: QueuePanelProps) {
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
                  className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-3 text-left"
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
                  // `aria-disabled`, never `disabled`: a real `disabled` drops the
                  // button out of the tab order, so the one person who most needs
                  // the reason — a keyboard user, in the state that is BLOCKED —
                  // could not reach it to hear one. The click is neutered by the
                  // guard below instead, and `sendNow` refuses again on its own.
                  aria-disabled={sendBlockedReason !== null}
                  onClick={() => {
                    if (sendBlockedReason === null) onSend(item.id);
                  }}
                  title={sendBlockedReason ?? undefined}
                  // The reason rides the ACCESSIBLE NAME, not `title`: an
                  // aria-label wins over title, so a title-only reason is
                  // announced to nobody. Blocked is the common state here — a
                  // queue mostly exists while a reply is streaming.
                  aria-label={
                    sendBlockedReason === null
                      ? `Send queued message ${i + 1} now`
                      : `Send queued message ${i + 1} now — unavailable: ${sendBlockedReason}`
                  }
                  // Always visible, unlike the tucked-away remove: this is the
                  // primary action on a queued row and the only way out of a
                  // stranded queue, so it must not need a hover to be found.
                  className={cn(
                    'focus-ring text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-sm transition-colors',
                    sendBlockedReason === null
                      ? 'hover:text-foreground'
                      : 'cursor-default opacity-40'
                  )}
                >
                  <CornerDownLeft className="size-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(item.id)}
                  className="focus-ring text-muted-foreground hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-sm opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
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
