/**
 * The label that travels under the cursor while a sidebar row is dragged
 * (spec D5, "Lift, ring, settle").
 *
 * @module features/dashboard-sidebar/ui/motion/DragLiftChip
 */
import { motion, useReducedMotion } from 'motion/react';
import { DRAG_LIFT_SCALE, DRAG_LIFT_SECONDS } from './sidebar-motion';

/** Props for {@link DragLiftChip}. */
export interface DragLiftChipProps {
  /** What is being dragged — a room's slug, an agent's name, a section's name. */
  label: string;
}

/**
 * The dragged thing, picked up off the panel.
 *
 * It lifts 2% with the floating shadow under it, so what is moving is obviously
 * the thing under the cursor rather than a copy of it. The shadow stays for a
 * reader who asked for less motion — it is depth, not movement — and only the
 * scale stands down.
 *
 * **Reduced motion is gated here rather than left to the shell's `MotionConfig
 * reducedMotion="user"`**, which was measured NOT to suppress this in this tree.
 * A component that trusts an ancestor for its accessibility promise keeps that
 * promise only until somebody moves it.
 *
 * Its own component so the Dev Playground can draw the real chip instead of a
 * lookalike that would go on looking right after a retune.
 *
 * @param props - The label to carry.
 */
export function DragLiftChip({ label }: DragLiftChipProps) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      initial={{ scale: 1 }}
      animate={{ scale: reducedMotion === true ? 1 : DRAG_LIFT_SCALE }}
      transition={{ duration: reducedMotion === true ? 0 : DRAG_LIFT_SECONDS }}
      className="bg-sidebar border-sidebar-border text-sidebar-foreground shadow-floating flex items-center rounded-md border px-2.5 py-1.5 text-xs font-medium"
    >
      {label}
    </motion.div>
  );
}
