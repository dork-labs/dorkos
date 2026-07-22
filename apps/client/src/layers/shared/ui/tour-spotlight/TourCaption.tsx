import { DorkLogo } from '@dorkos/icons/logos';

import { Button } from '@/layers/shared/ui/button';
import { cn } from '@/layers/shared/lib/utils';

/** Props for the DorkBot caption bubble rendered inside the spotlight. */
export interface TourCaptionProps {
  /** DorkBot's line for the current step. */
  caption: string;
  /** Label for the advance chip. Falls back to a step-appropriate default. */
  chipLabel?: string;
  /** Whether this is the final step (the chip finishes instead of advancing). */
  isLast: boolean;
  /** Advance to the next step. */
  onAdvance: () => void;
  /** End the tour (the caption's dismiss affordance). */
  onEnd: () => void;
}

/**
 * DorkBot's spoken caption for one spotlight step: avatar, the authored line, and
 * the chips that drive the tour. Fully our own markup — the spotlight library
 * contributes no chrome around it, so this is the entire popover the user sees.
 *
 * The advance chip is the first focusable element, so the focus trap lands focus
 * here on open. The line names its target in plain text, which is also what the
 * `aria-live` announcer reads.
 */
export function TourCaption({ caption, chipLabel, isLast, onAdvance, onEnd }: TourCaptionProps) {
  const advanceLabel = chipLabel ?? (isLast ? 'Got it' : 'Next');

  return (
    <div
      className={cn(
        'flex max-w-[min(20rem,calc(100vw-2rem))] flex-col gap-3 rounded-lg border',
        'bg-popover text-popover-foreground shadow-floating p-4'
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0">
          <DorkLogo size={28} className="dark:hidden" />
          <DorkLogo variant="white" size={28} className="hidden dark:block" />
        </span>
        <p className="text-sm leading-relaxed">{caption}</p>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onEnd}>
          Done
        </Button>
        <Button variant="default" size="sm" onClick={onAdvance}>
          {advanceLabel}
        </Button>
      </div>
    </div>
  );
}
