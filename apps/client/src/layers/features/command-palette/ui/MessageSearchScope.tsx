/**
 * The line saying what search can and cannot see (spec `message-search` **G4**).
 *
 * @module features/command-palette/ui/MessageSearchScope
 */
import { useState } from 'react';
import { Check, ChevronDown, Minus } from 'lucide-react';
import { cn, getPlatform } from '@/layers/shared/lib';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/layers/shared/ui';
import {
  SEARCH_SCOPE_COVERED,
  SEARCH_SCOPE_EMBED_GAP,
  SEARCH_SCOPE_GAPS,
  SEARCH_SCOPE_SUMMARY,
} from '../model/message-search-scope';

/** Props for {@link MessageSearchScope}. */
export interface MessageSearchScopeProps {
  /**
   * Open the detail list without waiting for a click.
   *
   * Set on the one state where the fine print IS the answer: a real query ran
   * and matched nothing, which is the moment the whole-word rule and the
   * never-indexed tool output stop being footnotes.
   *
   * @default false
   */
  detailOpen?: boolean;
  className?: string;
}

/**
 * One line by default, the full statement one click away.
 *
 * **The commitment is that a person can LEARN what search does not cover
 * without reading a spec — not that they must read it before typing.** The
 * whole four-bullet statement used to be on screen in every state but "there
 * are results", so opening ⌘⇧F meant meeting four multi-clause sentences before
 * a single keystroke. The gist now sits on one line where it always was
 * legible, and the detail is behind this disclosure, which opens itself the
 * moment a search comes back empty (DOR-1757).
 *
 * Ticks and dashes rather than ticks and crosses: a cross reads as an error,
 * and none of this is an error. It is a boundary, and a boundary drawn calmly
 * is the difference between a product that knows what it does and one that
 * looks broken.
 */
export function MessageSearchScope({ detailOpen = false, className }: MessageSearchScopeProps) {
  // `null` means "follow the situation". Once somebody has opened or closed it
  // themselves their choice wins for as long as the box is on screen, so the
  // next keystroke cannot reach up and undo the click they just made.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? detailOpen;

  // The embed reads an index it does not keep current, and says so. Appended to
  // the gaps rather than branching the whole list: every other line is equally
  // true in both windows.
  const gaps = getPlatform().isEmbedded
    ? [...SEARCH_SCOPE_GAPS, SEARCH_SCOPE_EMBED_GAP]
    : SEARCH_SCOPE_GAPS;

  return (
    <Collapsible open={open} onOpenChange={setChosen} className={cn('px-3 py-2', className)}>
      <CollapsibleTrigger
        className={cn(
          'text-muted-foreground/80 hover:text-foreground focus-ring text-2xs',
          'flex w-full items-start gap-2 rounded-sm py-1 text-left leading-relaxed transition-colors'
        )}
      >
        <span className="min-w-0 flex-1">{SEARCH_SCOPE_SUMMARY}</span>
        <ChevronDown
          className={cn('mt-0.5 size-3 shrink-0 transition-transform', !open && '-rotate-90')}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-2 space-y-1.5">
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
      </CollapsibleContent>
    </Collapsible>
  );
}
