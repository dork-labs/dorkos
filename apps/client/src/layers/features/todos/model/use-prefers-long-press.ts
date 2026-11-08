/**
 * Whether a to-do row moves by a long press rather than a grip: true where the main pointer is a
 * finger (DOR-3715). Decided by pointer, not width, so a touch tablet gets the long press it can
 * use and a narrow desktop window keeps its grip and keyboard moves.
 *
 * @module features/todos/model/use-prefers-long-press
 */
import { useMediaQuery } from '@/layers/shared/model';

/** The main pointer is coarse: a finger, not a mouse or a stylus. */
const COARSE_POINTER = '(pointer: coarse)';

/**
 * Whether to-do rows here move by a long press.
 *
 * @returns `true` while the main pointer is a finger; updates live.
 */
export function usePrefersLongPress(): boolean {
  return useMediaQuery(COARSE_POINTER);
}
