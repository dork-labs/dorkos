import { motion } from 'motion/react';
import { Sparkles } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

/** How many chips fit on one line before the row starts wrapping past its welcome. */
const MAX_VISIBLE = 4;

/**
 * How big a chip is, which is a question about what it is FOR.
 *
 * `compact` follows an answer that is already on screen — it is an afterthought
 * offered under something you were reading, and it stays out of the way.
 * `comfortable` is the only thing on screen worth pressing, so it is a real
 * target: 36px tall with room for the words, which is what the day-one openers
 * need on a phone.
 */
export type PromptSuggestionChipSize = 'compact' | 'comfortable';

/** Per-size chrome: the button, and how wide its text may run before truncating. */
const SIZES: Record<PromptSuggestionChipSize, string> = {
  compact: 'max-w-[200px] gap-1.5 px-2.5 py-1 text-xs',
  comfortable: 'min-h-9 max-w-[280px] gap-2 px-3 py-1.5 text-sm',
};

/** What {@link PromptSuggestionChips} draws and where a press goes. */
export interface PromptSuggestionChipsProps {
  /**
   * The lines offered, in order. Only the first four are drawn.
   *
   * `readonly` so a caller can pass a frozen registry straight in — a copy made
   * only to satisfy a type is a copy that can drift from the thing it copied.
   */
  suggestions: readonly string[];
  /** Called with the pressed line. What happens to it is the host's business. */
  onChipClick: (suggestion: string) => void;
  /**
   * What this row of chips IS, for a screen reader.
   *
   * The default names chat's case — lines the model offered to follow its own
   * answer with. A surface offering something else says so: "Suggested
   * follow-ups" read out on a fresh install's first screen would be describing a
   * conversation that has not happened yet.
   */
  ariaLabel?: string;
  /**
   * How big the chips are. See {@link PromptSuggestionChipSize}.
   *
   * `compact` by default, which is what chat has always drawn — the size is a
   * property of the occasion, and chat's occasion has not changed.
   */
  size?: PromptSuggestionChipSize;
}

/**
 * A row of one-press lines that put words in a composer.
 *
 * One chip, everywhere chips are offered. Chat draws the model's follow-up
 * suggestions with it, and the home surface draws its day-one starters
 * (team-room-home spec D3.6) — same shape, same press, so a chip means the same
 * thing wherever it turns up. Only the SIZE differs, and it differs for a reason
 * a reader can feel: see {@link PromptSuggestionChipSize}.
 *
 * It lives in `shared/ui` for exactly that reason: it holds no state, reads no
 * query and knows nothing about either surface. A press hands the line back and
 * the host decides whether that means sending a message or seeding a draft.
 *
 * @param props - The lines, the press handler, what to call the row, and how big.
 */
export function PromptSuggestionChips({
  suggestions,
  onChipClick,
  ariaLabel = 'Suggested follow-ups',
  size = 'compact',
}: PromptSuggestionChipsProps) {
  const visible = suggestions.slice(0, MAX_VISIBLE);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      role="group"
      aria-label={ariaLabel}
      className="mt-1.5 flex flex-wrap items-center gap-2"
    >
      {visible.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          aria-label={suggestion}
          // A chip wider than its cap is cut off mid-word, and the full text used
          // to live only in the accessible name — readable by a screen reader
          // and by nobody with a mouse. `title` is the same string, hovered.
          title={suggestion}
          onClick={() => onChipClick(suggestion)}
          className={cn(
            'bg-secondary text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring inline-flex items-center truncate rounded-md transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-offset-2',
            SIZES[size]
          )}
        >
          <Sparkles className={cn('shrink-0', size === 'compact' ? 'size-3' : 'size-3.5')} />
          <span className="truncate">{suggestion}</span>
        </button>
      ))}
    </motion.div>
  );
}
