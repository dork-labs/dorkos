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
  /**
   * Whether there is somewhere for this row to go.
   *
   * `false` for a conversation somebody had with a runtime's own command-line
   * tool: the transcript is on this machine and the words are searchable, and
   * DorkOS never ran it, so no session opens (DOR-2020). The row still appears
   * — finding the message is most of the value — and says why it does not open
   * rather than offering a link to an empty screen. It stays reachable by the
   * arrow keys either way; see the comment on the `CommandItem` for why it is
   * not marked disabled.
   */
  openable: boolean;
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
  openable,
}: MessageSearchHitRowProps) {
  const Icon = hit.source === 'rooms' ? Hash : MessageSquareText;

  return (
    <CommandItem
      value={value}
      onSelect={onSelect}
      // **Selectable, and inert.** `disabled` would have been the obvious way to
      // stop Enter here, and it is the wrong one: cmdk drops an
      // `aria-disabled` row out of the arrow-key run, out of Home/End, and out
      // of `aria-activedescendant` — so the one person who most needs to be
      // told this message exists but cannot be opened is the one who can never
      // reach the row that says it. The row stays in the run, its note is part
      // of the text a screen reader announces with it, and Enter simply does
      // nothing (`openHit` returns before it navigates or closes the box).
      className="flex flex-col items-start gap-1 py-2"
    >
      <div className="text-muted-foreground flex w-full min-w-0 items-center gap-1.5 text-xs">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{containerLabel}</span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0">{messageSearchSpeaker(hit.role)}</span>
        {!openable && (
          <>
            <span aria-hidden="true">·</span>
            {/* Said in the row rather than in a tooltip: it is the reason
                Enter does nothing here, and a reason nobody can hover on a
                phone is not a reason anybody reads. */}
            <span className="shrink-0">Ran outside DorkOS</span>
          </>
        )}
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
        <span dir="rtl" className="text-muted-foreground/70 text-3xs w-full truncate text-left">
          <bdi dir="ltr">{hit.containerPath}</bdi>
        </span>
      )}
    </CommandItem>
  );
}
