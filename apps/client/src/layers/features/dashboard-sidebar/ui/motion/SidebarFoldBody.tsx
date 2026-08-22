/**
 * A section's body, opening and closing on the fold spring (spec D5).
 *
 * @module features/dashboard-sidebar/ui/motion/SidebarFoldBody
 */
import type { ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { foldTransition } from './sidebar-motion';

/** Props for {@link SidebarFoldBody}. */
export interface SidebarFoldBodyProps {
  /** Whether the section is open. Closed unmounts the children. */
  open: boolean;
  /** The section's rows. */
  children: ReactNode;
}

/**
 * The fold, as a height spring.
 *
 * `initial={false}` means a section that is already open when the panel paints
 * is simply open — the entrance plays for a press and for nothing else, which is
 * what keeps a boot from animating (spec D6).
 *
 * The body still **unmounts** when it is folded, one beat later than it used to:
 * the rows go out of the document, out of the tab order and out of the roving
 * focus ring exactly as before.
 *
 * `overflow-hidden` is what makes the height mean anything, and it is why the
 * drop-target rings inside are inset rather than outset — an outer ring is the
 * first thing a clipped box loses.
 *
 * **One component rather than two copies**, because the Dev Playground shows
 * this fold: a demo that re-implemented it would go on looking right after a
 * retune moved the real one.
 *
 * @param props - Whether the section is open, and what is in it.
 */
export function SidebarFoldBody({ open, children }: SidebarFoldBodyProps) {
  const reducedMotion = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="body"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={foldTransition(reducedMotion)}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
