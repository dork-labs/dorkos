/**
 * ⌘K's last row — the honest boundary between finding a thing and searching
 * what was said in it (P3 AC-6).
 *
 * @module features/command-palette/ui/PaletteSearchHandoffRow
 */
import { MessageSquare } from 'lucide-react';
import { isMac } from '@/layers/shared/lib';
import { CommandItem } from '@/layers/shared/ui';

/** Props for {@link PaletteSearchHandoffRow}. */
export interface PaletteSearchHandoffRowProps {
  /** What was typed, drawn back so the row says what it would go and look for. */
  term: string;
  /**
   * Whether a scope chip is up.
   *
   * It changes the WORDS, not the behaviour: the hand-off is always global, so
   * under a chip the row has to say "all messages" or it reads as searching
   * inside the scope and quietly does not (`model/search-surface`).
   */
  isScoped?: boolean;
  /** Leave for the surface that searches what was said. */
  onSelect: () => void;
}

/**
 * *Search messages for "dash"…* — one row, at the bottom, that leaves.
 *
 * **It carries its shortcut now**, and that is the other half of a promise this
 * file made: the hint was deliberately absent while nothing in the cockpit
 * answered ⌘⇧F, because printing a key nobody has bound is the folklore the
 * footer rule exists to prevent. `MessageSearchDialog` binds it, so the hint
 * ships in the same commit the binding does.
 *
 * **The row draws last and is never promoted.** It is not a result — the
 * ranking has nothing to say about it — so it sits below every ranked row
 * whatever they scored, and cmdk's Down arrow reaches it the way it reaches any
 * other row.
 */
export function PaletteSearchHandoffRow({
  term,
  isScoped = false,
  onSelect,
}: PaletteSearchHandoffRowProps) {
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
        Search {isScoped ? 'all messages' : 'messages'} for{' '}
        <mark className="text-foreground bg-transparent font-semibold">“{term}”</mark>…
      </span>
      <kbd className="bg-muted text-muted-foreground shrink-0 rounded px-1 py-0.5 font-mono text-3xs">
        {isMac ? '⌘⇧F' : 'Ctrl⇧F'}
      </kbd>
    </CommandItem>
  );
}
