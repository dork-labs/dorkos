/**
 * The box saying what it can and cannot see (spec `message-search` **G4**).
 *
 * @module features/command-palette/ui/MessageSearchScope
 */
import { Check, Minus } from 'lucide-react';
import { cn, getPlatform } from '@/layers/shared/lib';
import {
  SEARCH_SCOPE_COVERED,
  SEARCH_SCOPE_EMBED_GAP,
  SEARCH_SCOPE_GAPS,
  SEARCH_SCOPE_HEADING,
  SEARCH_SCOPE_SUMMARY,
} from '../model/message-search-scope';

/** Props for {@link MessageSearchScope}. */
export interface MessageSearchScopeProps {
  className?: string;
}

/**
 * The full statement: what is searched, and what is not.
 *
 * Drawn in every state EXCEPT the one where results are on screen — before
 * anything is typed, while the query is too short, and when nothing matched.
 * Those are precisely the moments a person is asking "does this thing even look
 * at what I mean", and answering it there costs a list nobody is reading
 * anyway. When there are hits, the one-line {@link MessageSearchScopeLine} sits
 * under them instead.
 *
 * Ticks and dashes rather than ticks and crosses: a cross reads as an error,
 * and none of this is an error. It is a boundary, and a boundary drawn calmly
 * is the difference between a product that knows what it does and one that
 * looks broken.
 */
export function MessageSearchScope({ className }: MessageSearchScopeProps) {
  // The embed reads an index it does not keep current, and says so. Appended to
  // the gaps rather than branching the whole list: every other line is equally
  // true in both windows.
  const gaps = getPlatform().isEmbedded
    ? [...SEARCH_SCOPE_GAPS, SEARCH_SCOPE_EMBED_GAP]
    : SEARCH_SCOPE_GAPS;

  return (
    <div className={cn('px-3 py-3', className)}>
      <p className="text-muted-foreground mb-2 text-xs font-medium">{SEARCH_SCOPE_HEADING}</p>
      <ul className="space-y-1.5">
        {SEARCH_SCOPE_COVERED.map((line) => (
          <li key={line} className="text-muted-foreground flex gap-2 text-xs leading-relaxed">
            <Check className="text-brand mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{line}</span>
          </li>
        ))}
        {gaps.map((line) => (
          <li key={line} className="text-muted-foreground flex gap-2 text-xs leading-relaxed">
            <Minus className="mt-0.5 size-3.5 shrink-0 opacity-60" aria-hidden="true" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The same commitment in one line, for the state where results are on screen.
 *
 * It sits at the bottom of a list of hits and is deliberately quiet: somebody
 * reading results has what they came for, and this is only here so "why is that
 * not in the list" never has to be guessed at.
 */
export function MessageSearchScopeLine({ className }: MessageSearchScopeProps) {
  return (
    <p className={cn('text-muted-foreground/80 px-3 py-2 text-2xs leading-relaxed', className)}>
      {SEARCH_SCOPE_SUMMARY}
    </p>
  );
}
