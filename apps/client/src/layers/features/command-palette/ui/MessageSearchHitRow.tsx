/**
 * One matching message as a row in the search box (spec `message-search` §8).
 *
 * @module features/command-palette/ui/MessageSearchHitRow
 */
import { Hash, MessageSquareText } from 'lucide-react';
import type { SearchHit } from '@dorkos/shared/search-schemas';
import { formatRelativeTime } from '@/layers/shared/lib';
import { CommandItem } from '@/layers/shared/ui';
import { SearchExcerpt } from './SearchExcerpt';
import { messageSearchSpeaker } from '../model/message-search-target';

/** Props for {@link MessageSearchHitRow}. */
export interface MessageSearchHitRowProps {
  /** The message that matched. */
  hit: SearchHit;
  /** What to call the place it was said in, already resolved by the caller. */
  containerLabel: string;
  /**
   * cmdk's identity for this row. Composed by the caller from the hit's
   * coordinate, because a row's identity has to survive the list around it
   * changing.
   */
  value: string;
  /** Open the conversation or channel this was said in. */
  onSelect: () => void;
}

/**
 * A hit: where it was said, who said it, when, and the sentence it was said in.
 *
 * **Two lines, and the excerpt is the second one.** The coordinate is what
 * tells somebody whether this is the conversation they meant, and the excerpt
 * is what tells them whether it is the moment they meant — putting the
 * coordinate first means a person scanning a list of ten reads ten short
 * labels, not ten paragraphs.
 *
 * **The working directory is drawn only when there is one**, and it is drawn as
 * a third, quieter line rather than squeezed into the meta row. A conversation
 * in `~/work/api` and one in `~/scratch/api` are the same word to a reader who
 * only gets the last segment, and search is exactly where somebody is trying to
 * tell two similar places apart. A room has no directory and gets no line.
 *
 * The whole row is one accessible name: cmdk reads the element's text, which
 * comes out as "You · #general · 2h · …the thing about dogs…" — the same
 * sentence a person reads.
 */
export function MessageSearchHitRow({
  hit,
  containerLabel,
  value,
  onSelect,
}: MessageSearchHitRowProps) {
  const Icon = hit.source === 'rooms' ? Hash : MessageSquareText;

  return (
    <CommandItem value={value} onSelect={onSelect} className="flex flex-col items-start gap-1 py-2">
      <div className="text-muted-foreground flex w-full min-w-0 items-center gap-1.5 text-xs">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{containerLabel}</span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0">{messageSearchSpeaker(hit.role)}</span>
        {hit.createdAt !== null && (
          <span className="ml-auto shrink-0 tabular-nums">{formatRelativeTime(hit.createdAt)}</span>
        )}
      </div>
      <SearchExcerpt
        excerpt={hit.excerpt}
        className="text-foreground line-clamp-2 w-full text-sm break-words"
      />
      {hit.containerPath !== null && (
        // **Truncated at the START, not the end.** The leaf is the
        // distinguishing part of a path and the head is the part every project
        // shares, so ordinary truncation hides exactly what this line exists to
        // show: `/Users/me/work/very-long-name/api` and `…/scratch/api` clipped
        // from the right are the same nine characters. `direction: rtl` moves
        // the ellipsis to the left edge; the `bdi` keeps the path itself
        // rendering left-to-right inside it, so separators and any trailing
        // punctuation stay where they were typed.
        <span dir="rtl" className="text-muted-foreground/70 w-full truncate text-left text-[10px]">
          <bdi dir="ltr">{hit.containerPath}</bdi>
        </span>
      )}
    </CommandItem>
  );
}
