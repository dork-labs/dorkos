import { AnimatePresence, motion } from 'motion/react';
import { X, CornerDownLeft, ArrowUp, AppWindow } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { QueueItem } from '../../model/use-message-queue';

interface QueuePanelProps {
  queue: QueueItem[];
  /**
   * Id of the item under edit, or `null`. The id, not its position: the render
   * path compares it against the row it is already drawing, so the derived
   * index — which only exists for keyboard navigation — never has to reach the
   * panel at all.
   */
  editingId: string | null;
  /** Called with the item's stable id — positions shift as the queue dispatches. */
  onEdit: (id: string) => void;
  /** Called with the item's stable id — positions shift as the queue dispatches. */
  onRemove: (id: string) => void;
  /** Send this message next, ahead of everything else waiting. */
  onSend: (id: string) => void;
  /** Move this message one place earlier in the line. */
  onMoveUp: (id: string) => void;
  /**
   * What happens next, in the header beside the count — the answer to "when do
   * these go out". The server dispatches them itself, so the only thing that
   * genuinely holds the line is the agent waiting on a person.
   */
  statusNote: string;
}

/**
 * Inline queue card list rendered above the chat textarea.
 *
 * Each row is a plain container holding sibling buttons — edit, move-up,
 * send-next, and remove. Nesting them inside the edit button would be invalid
 * HTML, so browsers handle it inconsistently and assistive tech only ever sees
 * one control.
 *
 * **Send-next and move-up are both reorders**, because the server dispatches the
 * head as soon as the session frees up: "next" is the earliest any message can
 * go, and moving it to the front is the whole of it. Neither control appears on
 * the head itself, which is already as far forward as a message gets. Move-up
 * alone can express any order, which is why there is no fourth button for
 * move-down.
 *
 * A chip another window queued says so, quietly. It stays fully editable — the
 * queue belongs to the session, not to a window — it just does not pretend to be
 * yours.
 */
export function QueuePanel({
  queue,
  editingId,
  onEdit,
  onRemove,
  onSend,
  onMoveUp,
  statusNote,
}: QueuePanelProps) {
  // Also guarded at the call site, which is what lets AnimatePresence see this
  // panel leave and play the exit below. Kept here too so the component never
  // renders a "Queued (0)" header for any other caller.
  if (queue.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2 }}
      className="mb-1.5 overflow-hidden"
    >
      {/* The count alone never said the one thing a person waiting actually
          wants to know — when these go out. */}
      <div className="text-muted-foreground mb-1 flex items-baseline gap-1 text-xs">
        <span className="font-medium">Queued ({queue.length})</span>
        <span className="truncate">&mdash; {statusNote}</span>
      </div>
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
                  // The left border is always here, transparent at rest: applying
                  // it only while editing shifted the whole row 2px sideways the
                  // moment you clicked into it.
                  'group flex w-full items-center gap-1 rounded-md border-l-2 border-l-transparent pr-2 transition-colors',
                  editingId === item.id ? 'border-l-primary bg-muted' : 'hover:bg-muted/50'
                )}
              >
                <button
                  type="button"
                  onClick={() => onEdit(item.id)}
                  aria-current={editingId === item.id ? true : undefined}
                  className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-3 text-left"
                >
                  <span className="text-muted-foreground shrink-0 text-xs font-medium">
                    {i + 1}.
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-muted-foreground line-clamp-1 text-sm">
                      {item.content}
                    </span>
                    {item.notice !== null && (
                      <span className="text-muted-foreground/70 line-clamp-1 text-xs">
                        {item.notice}
                      </span>
                    )}
                  </span>
                  {!item.mine && (
                    <span
                      className="text-muted-foreground/60 flex shrink-0 items-center"
                      title="Queued from another window"
                    >
                      <AppWindow className="size-3" aria-hidden="true" />
                      <span className="sr-only">Queued from another window</span>
                    </span>
                  )}
                </button>
                {/* Nothing to reorder on the head — it is already as far forward
                    as a message gets, and offering a control that cannot do
                    anything is worse than not offering one. */}
                {i > 0 && (
                  <button
                    type="button"
                    onClick={() => onMoveUp(item.id)}
                    className="focus-ring text-muted-foreground hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-sm opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                    aria-label={`Move queued message ${i + 1} earlier`}
                  >
                    <ArrowUp className="size-3" />
                  </button>
                )}
                {i > 0 && (
                  <button
                    type="button"
                    onClick={() => onSend(item.id)}
                    aria-label={`Send queued message ${i + 1} next`}
                    // Always visible, unlike the tucked-away reorder and remove:
                    // this is the primary action on a queued row, so it must not
                    // need a hover to be found.
                    className="focus-ring text-muted-foreground hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-sm transition-colors"
                  >
                    <CornerDownLeft className="size-3" />
                  </button>
                )}
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
