/**
 * The mark that says an agent is no longer on your team — beside its name on
 * every message it left behind, and on the direct message roster that keeps it
 * (DOR-2095).
 *
 * @module entities/room/ui/RetiredMark
 */
import { cn } from '@/layers/shared/lib';

export interface RetiredMarkProps {
  /** Whether the author is retired. `false` or absent renders nothing. */
  retired: boolean | undefined;
  className?: string;
}

/**
 * "· Retired", in the same quiet register as the origin mark beside it.
 *
 * **Words, not a tooltip.** A retired agent reads nothing and answers nothing,
 * so a person scanning a roster or a thread has to be able to tell at a glance
 * that the name they see is history rather than somebody listening. The title
 * adds the why for a pointer that lingers; the screen-reader phrase says it
 * without the decorative middot.
 */
export function RetiredMark({ retired, className }: RetiredMarkProps) {
  if (retired !== true) return null;

  return (
    <span
      data-slot="retired-mark"
      data-testid="retired-mark"
      title="This agent was unregistered. Its messages stay."
      className={cn('text-muted-foreground inline-flex items-center gap-1 text-xs', className)}
    >
      <span aria-hidden className="inline-flex items-center gap-1">
        <span>·</span>
        Retired
      </span>
      <span className="sr-only">, retired</span>
    </span>
  );
}
