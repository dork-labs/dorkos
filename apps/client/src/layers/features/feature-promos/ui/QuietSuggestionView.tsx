import { X } from 'lucide-react';
import type { QuietSuggestionCopy } from '../model/promo-types';

/** What {@link QuietSuggestionView} says, and what the two presses do. */
export interface QuietSuggestionViewProps {
  /** The question, and the thing pressing it would do. */
  suggestion: QuietSuggestionCopy;
  /**
   * The promo's title, for the dismiss control's accessible name.
   *
   * "Dismiss suggestion" on its own tells a screen-reader user which button
   * they are on and nothing about what disappears when they press it.
   */
  promoTitle: string;
  /** Take it up — opens whatever the promo opens. */
  onAccept: () => void;
  /** Wave it away, for good. */
  onDismiss: () => void;
}

/**
 * One sentence, a way in, and a way out.
 *
 * A second line under "All quiet.", set smaller and dimmer than the line above
 * it: the forward look is a fact about this morning, this is an offer, and the
 * type should say which is which before either is read (team-room-home spec
 * D5.3).
 *
 * **Dismissing is exactly as easy as accepting**: two adjacent buttons, one
 * press each, no confirmation on either. The X is quieter than the action but it
 * is never hidden — a dismiss that only appears on hover is a dismiss a phone
 * cannot find — and its hit area is padded well past the glyph without the glyph
 * growing to match.
 *
 * Presentational: it is handed its copy and its two callbacks. Whether there is
 * anything to suggest at all is {@link QuietSuggestion}'s business.
 *
 * @param props - The copy, the promo title, and the accept/dismiss handlers.
 */
export function QuietSuggestionView({
  suggestion,
  promoTitle,
  onAccept,
  onDismiss,
}: QuietSuggestionViewProps) {
  return (
    <p data-slot="quiet-suggestion" className="text-muted-foreground/70 text-2xs mt-1">
      {suggestion.question}{' '}
      <button
        type="button"
        onClick={onAccept}
        className="text-muted-foreground hover:text-foreground focus-ring rounded-sm font-medium underline-offset-4 transition-colors hover:underline focus-visible:underline"
      >
        {suggestion.action}
      </button>
      <button
        type="button"
        aria-label={`Dismiss suggestion: ${promoTitle}`}
        onClick={onDismiss}
        // Negative margin against the padding: a 24px target on a 12px glyph,
        // and the line keeps the height it would have had without a button in
        // it.
        className="text-muted-foreground/60 hover:text-foreground focus-ring -my-1.5 ml-0.5 inline-flex translate-y-[3px] items-center justify-center rounded-sm p-1.5 align-baseline transition-colors"
      >
        <X className="size-3" />
      </button>
    </p>
  );
}
