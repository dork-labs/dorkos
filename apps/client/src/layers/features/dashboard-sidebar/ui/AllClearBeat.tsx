/**
 * "All clear ✓" — what Heads up says on its way out (BC-50).
 *
 * @module features/dashboard-sidebar/ui/AllClearBeat
 */
import { Check } from 'lucide-react';

/**
 * The beat itself: one line, on the zone's own tint, for 2.5 seconds.
 *
 * Presentational and nothing else — it takes no props, holds no timer and reads
 * no model. Whether it is on screen is `useAllClearBeat`'s decision, and it is
 * never rendered under a reduced-motion preference because that hook never asks
 * for it.
 *
 * It is not a row: there is nothing to press and nowhere to go. An operator who
 * has just cleared their queue should not find a control where the queue was.
 */
export function AllClearBeat() {
  return (
    <p
      data-slot="sidebar-all-clear"
      className="text-sidebar-foreground/70 flex min-h-7 items-center gap-1.5 px-2 text-[13px]"
    >
      <Check className="text-status-success size-3.5 shrink-0" aria-hidden />
      All clear
    </p>
  );
}
