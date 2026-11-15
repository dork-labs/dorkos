import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AppWindow, ArrowUp, CornerDownLeft, X } from 'lucide-react';
import { cn, COLLAPSE_TRANSITION, COLLAPSE_VARIANTS, SPRING } from '@/layers/shared/lib';
import type { QueueItem } from '../../model/use-message-queue';
import type { AgentQueueActions } from '../../model/messaging/use-agent-queue-actions';
import { queueHeaderCount } from '../../lib/queue-sender';
import { QueueAgentRow } from './QueueAgentRow';

/**
 * Invisible reach that grows each 24px row action into a 32px touch target
 * below `md`, without moving its neighbors.
 *
 * **Bounded by the row it sits in, both ways.** Move-up, send-next and
 * remove sit shoulder to shoulder with an 8px gap between them below `md`
 * (the row switches to `gap-2`, `md:gap-1` restores today's 4px) — half of
 * that, 4px, is as far as one button can reach before it meets its
 * neighbor's own reach coming the other way, so `-inset-1` is the most any
 * side can safely claim horizontally.
 *
 * Vertically the ceiling is the row itself: the edit button beside these
 * sets the row's height at a 32px floor (`py-1.5` plus one line of
 * `text-sm`, present on every row since `item.content` is never empty), and
 * a 24px button centered in a 32px row already has 4px of slack above and
 * below before it would spill into the 2px `space-y-0.5` gap the next
 * queued row sits behind. `-inset-1` spends exactly that slack and no more,
 * so a mistap can never land on the wrong queued message's own controls —
 * the exact failure this reach exists to prevent.
 */
const TOUCH_REACH = 'after:absolute after:-inset-1 md:after:hidden';

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
  /**
   * Switch now, on a message held for the agent's background work: run it
   * anyway, stopping that work. The row says what it stops.
   */
  onSwitchNow?: () => void;
  /** Send now and Don't deliver, for a message another agent sent (DOR-3060). */
  agentActions: AgentQueueActions;
  /**
   * Focus the composer: where focus goes when the last row leaves after Send
   * now or Don't deliver, so a keyboard user never lands on the page itself.
   */
  onFocusComposer?: () => void;
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
 * yours. A message another chat sent is its own quiet row (`QueueAgentRow`):
 * it names its sender above its words, so it never reads as the person's own,
 * and offers only Send now and Don't deliver (DOR-3060).
 */
export function QueuePanel({
  queue,
  editingId,
  onEdit,
  onRemove,
  onSend,
  onMoveUp,
  statusNote,
  onSwitchNow,
  agentActions,
  onFocusComposer,
}: QueuePanelProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const leaving = useRef<{ id: string; index: number; last: boolean } | null>(null);
  const focusComposer = useRef(onFocusComposer);
  focusComposer.current = onFocusComposer;

  // A row that left after Send now or Don't deliver hands focus to the row
  // now in its place, else the one before it. Only when focus was in that row:
  // a click elsewhere meanwhile is the person's own choice.
  useEffect(() => {
    const left = leaving.current;
    if (!left) return;
    if (queue.some((item) => item.id === left.id)) {
      // Send now could only move it first: it stays, and so does focus.
      if (agentActions.notices[left.id] !== undefined) leaving.current = null;
      return;
    }
    leaving.current = null;
    const active = document.activeElement;
    const inLeftRow = active?.closest(`[data-queue-row="${left.id}"]`) != null;
    if (!inLeftRow && active !== null && active !== document.body) return;
    const target = queue[left.index] ?? queue[left.index - 1];
    const next = target
      ? listRef.current?.querySelector<HTMLElement>(`[data-queue-row="${target.id}"] button`)
      : undefined;
    if (next) next.focus();
    else focusComposer.current?.();
  }, [queue, agentActions.notices]);

  // The last row leaving takes the panel with it: focus goes to the composer.
  useEffect(
    () => () => {
      // Only when focus fell to the page with the row, never away from where
      // the person has since moved it.
      const active = document.activeElement;
      if (leaving.current?.last && (active === null || active === document.body)) {
        focusComposer.current?.();
      }
    },
    []
  );

  const noteLeaving = (id: string): void => {
    const index = queue.findIndex((item) => item.id === id);
    leaving.current = { id, index, last: queue.length === 1 };
  };

  // Also guarded at the call site, which is what lets AnimatePresence see this
  // panel leave and play the exit below. Kept here too so the component never
  // renders a "Queued (0)" header for any other caller.
  if (queue.length === 0) return null;

  return (
    <motion.div
      variants={COLLAPSE_VARIANTS}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={COLLAPSE_TRANSITION}
      className="mb-1.5 overflow-hidden"
    >
      {/* The count alone never said the one thing a person waiting actually
          wants to know — when these go out. */}
      <div className="text-muted-foreground mb-1 flex items-baseline gap-1 text-xs">
        <span className="font-medium">{queueHeaderCount(queue)}</span>
        <span className="truncate">&middot; {statusNote}</span>
      </div>
      <div ref={listRef} className="max-h-[40vh] space-y-0.5 overflow-y-auto">
        <AnimatePresence mode="popLayout">
          {queue.map((item, i) => (
            <motion.div
              key={item.id}
              data-queue-row={item.id}
              initial={{ opacity: 0, y: -4 }}
              animate={{
                opacity: 1,
                y: 0,
                transition: SPRING.glide,
              }}
              exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
              layout
            >
              {item.fromChat ? (
                <QueueAgentRow
                  item={item}
                  index={i}
                  actions={agentActions}
                  onSwitchNow={onSwitchNow}
                  onLeaving={noteLeaving}
                />
              ) : (
                <div
                  className={cn(
                    // The left border is always here, transparent at rest: applying
                    // it only while editing shifted the whole row 2px sideways the
                    // moment you clicked into it.
                    //
                    // `gap-2` below `md` (not the desktop `gap-1`) is what the three
                    // action buttons' invisible reach spends: half of it, 4px, on
                    // each side of each button — see the buttons below.
                    'group flex w-full items-center gap-2 rounded-md border-l-2 border-l-transparent pr-2 transition-colors md:gap-1',
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
                      {item.waiting !== undefined && (
                        <span className="text-muted-foreground/70 line-clamp-1 text-xs">
                          {item.waiting.line}
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
                  {/* Held for background work: the one way to run it anyway. A
                    text button, not an icon — it ends work, so it says so. */}
                  {item.waiting !== undefined && onSwitchNow !== undefined && (
                    <>
                      <button
                        type="button"
                        onClick={onSwitchNow}
                        title={item.waiting.switchHint}
                        aria-describedby={`switch-now-${item.id}`}
                        className="focus-ring text-muted-foreground hover:text-foreground shrink-0 rounded-sm px-1.5 py-1 text-xs font-medium transition-colors"
                      >
                        Switch now
                      </button>
                      <span id={`switch-now-${item.id}`} className="sr-only">
                        {item.waiting.switchHint}
                      </span>
                    </>
                  )}
                  {/* Nothing to reorder on the head — it is already as far forward
                    as a message gets, and offering a control that cannot do
                    anything is worse than not offering one. */}
                  {i > 0 && (
                    <button
                      type="button"
                      onClick={() => onMoveUp(item.id)}
                      className={cn(
                        'focus-ring text-muted-foreground hover:text-foreground relative flex size-6 shrink-0 items-center justify-center rounded-sm opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100',
                        TOUCH_REACH
                      )}
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
                      className={cn(
                        'focus-ring text-muted-foreground hover:text-foreground relative flex size-6 shrink-0 items-center justify-center rounded-sm transition-colors',
                        TOUCH_REACH
                      )}
                    >
                      <CornerDownLeft className="size-3" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onRemove(item.id)}
                    className={cn(
                      'focus-ring text-muted-foreground hover:text-foreground relative flex size-6 shrink-0 items-center justify-center rounded-sm opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100',
                      TOUCH_REACH
                    )}
                    aria-label={`Remove queued message ${i + 1}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
