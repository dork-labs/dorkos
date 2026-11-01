/**
 * The one status mark a sidebar row carries.
 *
 * @module features/dashboard-sidebar/ui/RowStatusMark
 */
import { cn } from '@/layers/shared/lib';
import { statusDotClass } from '@/layers/shared/ui';

/** What a row can be marked with, highest priority first. */
export type RowMark = 'needs-you' | 'error' | 'working' | 'unseen';

/**
 * Shape, colour and size per mark (Phase 4 §4).
 *
 * **Needs you is a diamond in the brand ink, not an amber dot.** The amber dot
 * measured 2.69:1 on the light panel and 2.38 on a selected row, under the 3:1 a
 * mark owes, and it was 6px of colour beside a green dot and a grey one: a
 * reader who cannot tell the hues apart could not tell it from them at all. A
 * shape says it without the colour, and the ink passes at 6.11 / 5.42.
 *
 * **Unseen is grey.** Its blue measured 2.96:1, and it is the quietest thing a
 * row can say, so it takes the panel's own ink at 60%.
 *
 * Only working moves (`statusDotClass` adds the pulse): a state holds still.
 */
const MARK_CLASS: Record<RowMark, string> = {
  'needs-you': 'bg-brand-text size-[7px] rotate-45 rounded-[1px] max-md:size-2.5',
  error: cn('size-1.5 rounded-full max-md:size-2', statusDotClass('error')),
  working: cn('size-1.5 rounded-full max-md:size-2', statusDotClass('working')),
  unseen: 'bg-sidebar-foreground/60 size-1.5 rounded-full max-md:size-2',
};

interface RowStatusMarkProps {
  /** Which mark to draw. */
  mark: RowMark;
  /** What a screen reader hears, e.g. "needs you". */
  label: string;
}

/**
 * A row's status mark: a diamond for needs-you, a dot for the rest.
 *
 * `role="img"` with a name, never `role="status"`: a live region on every row
 * would announce the whole list at once. Takes props only and subscribes to
 * nothing, so a row that draws it re-renders exactly as often as before.
 *
 * @param props - The mark and its spoken name.
 */
export function RowStatusMark({ mark, label }: RowStatusMarkProps) {
  return (
    <span
      role="img"
      aria-label={label}
      data-row-mark={mark}
      className={cn('shrink-0', MARK_CLASS[mark])}
    />
  );
}
