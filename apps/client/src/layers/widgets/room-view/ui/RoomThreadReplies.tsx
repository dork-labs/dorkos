import { useId, useMemo, useState } from 'react';
import { buildTimelineRows } from '@/layers/shared/lib';
import type { AuthorRef, RoomEntry } from '@/layers/entities/room';
import { toMessageAuthor } from '../lib/room-timeline';
import { RoomEntryRow } from './RoomEntryRow';

interface RoomThreadRepliesProps {
  /** The room the thread lives in. */
  roomId: string;
  /** The replies belonging to one entry, oldest first. Never empty. */
  replies: RoomEntry[];
  /** The room's roster, keyed by author id — the only place a name comes from. */
  authors: ReadonlyMap<string, AuthorRef>;
  /** The same roster as display names, for a reaction's "who reacted" line. */
  authorNames: ReadonlyMap<string, string>;
  /** The reader's own author id here, passed through to each reply's actions. */
  viewerAuthorId: string;
  /** This reader's three most-used emoji, passed through to each reply. */
  reactionFrequents: readonly string[];
  /** True when the room's live stream has given up — reactions go with it. */
  streamStalled?: boolean;
  /** "Now" as epoch ms, for the same reason the timeline takes one. */
  now: number;
}

/**
 * How many replies a thread shows before it asks.
 *
 * Three, because the room has to stay a room. Measured in the browser, forty
 * replies rendered inline run 1,364px — 1.6 viewports — which pushes the
 * channel's own next message off screen and turns a channel into a transcript
 * of one aside.
 */
const INLINE_REPLIES = 3;

/**
 * How a thread is written above its replies.
 *
 * @param count - How many replies the thread holds.
 */
function replyLabel(count: number): string {
  return count === 1 ? '1 reply' : `${count} replies`;
}

/**
 * The replies belonging to one entry, drawn under it.
 *
 * A thread is a relation between entries (ADR 260728-022013), so its replies
 * live in this room's log and belong under the entry that heads them rather
 * than loose in the room's flow. The rule down the left starts under that
 * entry's avatar, so the group reads as hanging off it before anything is read.
 *
 * **The first three are shown and the rest are one press away.** A bare count
 * would be an affordance with nowhere to go — the cockpit has no thread pane,
 * and opening a room already marks its threads read, so naming content the
 * reader cannot reach and then marking it read is the one shape this must not
 * take. Showing all of them fails the other way: past a handful, the thread
 * buries the conversation it is an aside to. Expanding in place costs nothing
 * and promises nothing a pane would have to keep.
 *
 * The honesty argument does not by itself choose between three and all of them
 * — anything below the fold is marked read unseen either way, because rendering
 * is not reading. What it rules out is a count with no way to open it.
 *
 * Author grouping is the room's own — the same `buildTimelineRows` rules, so a
 * person answering twice gets one header here too. Day boundaries are dropped:
 * a thread is a short aside off an entry the room has already dated, and a
 * full-bleed "Today" inside a three-line group is noise.
 */
export function RoomThreadReplies({
  roomId,
  replies,
  authors,
  authorNames,
  viewerAuthorId,
  reactionFrequents,
  streamStalled,
  now,
}: RoomThreadRepliesProps) {
  const [expanded, setExpanded] = useState(false);
  const labelId = useId();

  const visible = expanded ? replies : replies.slice(0, INLINE_REPLIES);
  const hidden = replies.length - visible.length;

  const rows = useMemo(
    () =>
      buildTimelineRows(
        visible.map((reply) => ({
          id: reply.id,
          authorId: reply.authorId,
          timestamp: reply.createdAt,
        })),
        { now }
      ),
    [visible, now]
  );

  return (
    // Named BY the visible line rather than carrying an `aria-label` with the
    // same words: an identical label and child text make a screen reader
    // announce the count twice (the DOR-583 shape).
    <div
      role="group"
      aria-labelledby={labelId}
      data-testid="room-thread"
      className="border-border ml-[calc(var(--msg-padding-x)_+_var(--msg-gutter-width)_/_2)] flex flex-col border-l pb-2"
    >
      <p id={labelId} className="text-muted-foreground px-[var(--msg-padding-x)] pt-1 text-xs">
        {replyLabel(replies.length)}
      </p>
      {rows.map((row) =>
        row.kind === 'item' ? (
          <RoomEntryRow
            key={row.key}
            roomId={roomId}
            entry={visible[row.index]!}
            author={toMessageAuthor(visible[row.index]!.authorId, authors)}
            authorRef={authors.get(visible[row.index]!.authorId)}
            viewerAuthorId={viewerAuthorId}
            authorNames={authorNames}
            reactionFrequents={reactionFrequents}
            streamStalled={streamStalled}
            grouping={row.grouping}
          />
        ) : null
      )}
      {(hidden > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="focus-ring text-muted-foreground hover:text-foreground mt-1 self-start rounded px-[var(--msg-padding-x)] text-xs underline underline-offset-2"
        >
          {expanded ? 'Show fewer replies' : `Show ${hidden} more`}
        </button>
      )}
    </div>
  );
}
