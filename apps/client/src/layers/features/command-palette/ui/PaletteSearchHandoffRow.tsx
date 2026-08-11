/**
 * ⌘K's last row — the honest boundary between finding a thing and searching
 * what was said in it (P3 AC-6).
 *
 * @module features/command-palette/ui/PaletteSearchHandoffRow
 */
import { MessageSquare } from 'lucide-react';
import { CommandItem } from '@/layers/shared/ui';

/** Props for {@link PaletteSearchHandoffRow}. */
export interface PaletteSearchHandoffRowProps {
  /** What was typed, drawn back so the row says what it would go and look for. */
  term: string;
  /** Leave for the surface that searches what was said. */
  onSelect: () => void;
}

/**
 * *Search messages for "dash"…* — one row, at the bottom, that leaves.
 *
 * It is rendered only when a surface to leave FOR exists
 * (`model/search-surface`), so this component never draws a dead end. When
 * there is none the palette simply ends at its last result, which is the truth:
 * this cockpit cannot search message content yet.
 *
 * **It carries no keyboard hint**, and the mockup's `⌘⇧F` is deliberately not
 * here. The palette does not own that binding and nothing in this cockpit
 * answers it; a hint is a promise that a key works, and printing one for a
 * shortcut nobody has bound is the exact folklore the footer rule exists to
 * prevent. Whoever ships the search surface ships its shortcut, and the hint
 * belongs in the same commit.
 *
 * **The row draws last and is never promoted.** It is not a result — the
 * ranking has nothing to say about it — so it sits below every ranked row
 * whatever they scored, and cmdk's Down arrow reaches it the way it reaches any
 * other row.
 */
export function PaletteSearchHandoffRow({ term, onSelect }: PaletteSearchHandoffRowProps) {
  return (
    <CommandItem
      // A fixed value rather than the query: cmdk uses this as the row's
      // identity for selection, and a value that changed with every keystroke
      // would drop the highlight mid-type.
      value="search-messages-handoff"
      onSelect={onSelect}
      className="flex items-center gap-2 py-2"
    >
      <MessageSquare className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm">
        Search messages for{' '}
        <mark className="text-foreground bg-transparent font-semibold">“{term}”</mark>…
      </span>
    </CommandItem>
  );
}
