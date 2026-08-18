/**
 * What a reader gets INSTEAD of being taken to the bottom by somebody else's
 * message.
 *
 * Two controls, both hanging off the scroller rather than off the list, so
 * neither can move a row: the pill that says something arrived while you were
 * reading back, and the button that takes you to the newest message.
 *
 * @module features/conversation/ui/TimelineAffordances
 */
import { AnimatePresence, motion } from 'motion/react';
import { ArrowDown } from 'lucide-react';

/** What the two affordances need to know. */
export interface TimelineAffordancesProps {
  /** True when rows arrived while the reader was scrolled away. */
  hasNewRows: boolean;
  /** True while the reader is at the newest message. */
  isAtBottom: boolean;
  /** False on an empty conversation, which has nowhere to jump to. */
  hasRows: boolean;
  /** Take the reader to the newest row. */
  onJump: () => void;
}

/**
 * Draw the two scrolled-away affordances.
 *
 * @param props - What arrived, where the reader is, and how to take them back.
 */
export function TimelineAffordances({
  hasNewRows,
  isAtBottom,
  hasRows,
  onJump,
}: TimelineAffordancesProps) {
  return (
    <>
      <AnimatePresence>
        {hasNewRows && !isAtBottom && (
          <motion.button
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.2 }}
            onClick={onJump}
            data-slot="conversation-new-messages"
            data-testid="conversation-new-messages"
            className="bg-foreground text-background hover:bg-foreground/90 absolute bottom-4 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium shadow-sm transition-colors"
          >
            New messages
            {/*
              The announcement rides a sibling, not the button. `role="status"`
              on the button itself REPLACES its implicit button role, so a
              screen reader reached a focusable thing it announced as a status
              with nothing saying it could be pressed. The button stays a
              button; the live region is this.
            */}
            <span role="status" aria-live="polite" className="sr-only">
              New messages
            </span>
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!isAtBottom && hasRows && (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.15 }}
            onClick={onJump}
            data-slot="conversation-jump-to-latest"
            data-testid="conversation-jump-to-latest"
            className="bg-background absolute right-4 bottom-4 rounded-full border p-2 shadow-sm transition-shadow hover:shadow-md"
            aria-label="Scroll to bottom"
          >
            <ArrowDown className="size-(--size-icon-md)" />
          </motion.button>
        )}
      </AnimatePresence>
    </>
  );
}
