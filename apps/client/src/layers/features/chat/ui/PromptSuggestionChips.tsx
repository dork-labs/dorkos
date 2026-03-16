import { motion } from 'motion/react';
import { Sparkles } from 'lucide-react';

interface PromptSuggestionChipsProps {
  suggestions: string[];
  onChipClick: (suggestion: string) => void;
}

const MAX_VISIBLE = 4;

/** Renders SDK-provided follow-up suggestion chips below the assistant message. */
export function PromptSuggestionChips({ suggestions, onChipClick }: PromptSuggestionChipsProps) {
  const visible = suggestions.slice(0, MAX_VISIBLE);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      role="group"
      aria-label="Suggested follow-ups"
      className="mt-1.5 flex flex-wrap items-center justify-center gap-2 sm:justify-start"
    >
      {visible.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          aria-label={suggestion}
          onClick={() => onChipClick(suggestion)}
          className="bg-secondary text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring inline-flex max-w-[200px] items-center gap-1.5 truncate rounded-md px-2.5 py-1 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-offset-2"
        >
          <Sparkles className="size-3 shrink-0" />
          <span className="truncate">{suggestion}</span>
        </button>
      ))}
    </motion.div>
  );
}
