/**
 * The quiet line under a thread's root — the fourth kind of row a conversation
 * can hold.
 *
 * @module features/conversation/ui/rows/ThreadReplyRow
 */
import { useState } from 'react';
import { cn } from '@/layers/shared/lib';
import { threadReplySummary, type RoomEntry } from '@/layers/entities/room';
import { useConversation } from '../../model/conversation-context';
import { formatAbsoluteTime, formatTime } from '../../lib/format-entry-time';

interface ThreadReplyRowProps {
  /**
   * The DOM id to put on the row, so closing the panel can put the caret back
   * on the line that opened it. Named by the host, which owns the id scheme.
   */
  id?: string;
  /** The replies hanging off one entry. Never empty — no replies, no row. */
  replies: RoomEntry[];
  /**
   * How many replies the thread has in the ROOM, when that is more than the
   * ones above — a thread reaching back past the loaded page. Omitted for every
   * other thread, where the replies handed in are the whole of it.
   */
  totalReplies?: number;
  /** The reader's read cursor, frozen at the room's open, or null for a non-member. */
  lastReadSeq: number | null;
  /** True while this thread is the one the panel is showing. */
  open: boolean;
  /** Open this thread's panel. */
  onOpen: () => void;
}

/**
 * The quiet line under a thread's root: "↳ 3 replies · last 9:45 AM".
 *
 * **This replaces the inline reply gathering, which is retired** (design record
 * §3). Replies used to hang under their root in the room's own scroll, capped
 * at three with the rest one press away. The operator chose the side panel over
 * that, and the reason it is a replacement rather than an addition is the whole
 * point of the decision: a room with threads drawn in it has two idioms for one
 * conversation, and the scroll belongs to whichever thread is longest. Now the
 * room shows a room, and a thread has a place to be.
 *
 * The row is a button because it is the way in — the affordance the old bare
 * count could not have been, because there was nowhere for it to go.
 *
 * **Unread is derived, never stored** (design record §3.3): a reply above the
 * reader's cursor is one they have not seen, so the row renders in accent and
 * counts them. `threadReplySummary` owns that arithmetic and says why the
 * cursor it reads is the frozen one.
 *
 * The reply COUNT flips when it advances (design record §5.5) — the one-shot
 * mechanical-counter snap, keyed the way `EntryReactionRow` keys its rolling
 * count: a ref seeded `null` at mount, so a row arriving with three replies
 * already on it is drawn at rest and only a genuine increment moves.
 */
export function ThreadReplyRow({
  id,
  replies,
  totalReplies,
  lastReadSeq,
  open,
  onOpen,
}: ThreadReplyRowProps) {
  const { capabilities } = useConversation();
  const { count, lastAt, unread } = threadReplySummary(replies, lastReadSeq, totalReplies);
  const time = formatTime(lastAt);

  // Whether this count has MOVED since the row was drawn, which is what
  // separates "the thread just gained a reply" from "this row has three replies
  // and always did". Only the first one is motion.
  //
  // State adjusted during render — the pattern React recommends for "reset some
  // state when a prop changes" and the one `useFrozenReadCursor` already uses
  // here. React re-runs the component and throws the first pass away, so the
  // extra pass costs a render rather than a frame of the wrong thing. A ref
  // would answer the same question and is what `EntryReactionRow` reaches for,
  // but this row's answer is a plain scalar comparison, and state keeps it out
  // of render entirely.
  const [seen, setSeen] = useState({ count, bumped: false });
  if (seen.count !== count) setSeen({ count, bumped: true });
  const bumped = seen.count === count && seen.bumped;

  // A conversation with no threads has nothing for this line to summarise and
  // nowhere for it to lead. The gate is the capability rather than the caller's
  // discipline: a surface that gains a timeline before it gains threads would
  // otherwise draw a row that opens a panel it does not have. Below the state
  // above, because the hooks a row calls may not depend on what it draws.
  if (!capabilities.threads) return null;

  return (
    <button
      type="button"
      // Addressable, so closing the panel can put the caret back on the row
      // that opened it — see the host's `threadRowId`.
      id={id}
      data-slot="thread-reply-row"
      data-testid="room-thread-replies"
      data-unread={unread > 0 ? '' : undefined}
      aria-expanded={open}
      onClick={onOpen}
      className={cn(
        'focus-ring ml-[calc(var(--msg-padding-x)_+_var(--msg-gutter-width)_+_var(--msg-gap))]',
        'mb-1 w-fit rounded text-left text-xs transition-colors',
        // **On a phone this is the ONLY way into a thread**, so it is the one
        // control down here that gets BIGGER rather than merely reaching
        // further: `px-2 py-2` below the breakpoint, the original `px-1 py-0.5`
        // above it.
        //
        // It reached instead, once — 12px of invisible `::after` on every side,
        // the `SidebarGroupAction` trick. Measured in Chromium at 390×844, that
        // spanned y160–208 while the reaction pills above claimed y128–178, so
        // `elementFromPoint` handed this row 18px of the pills' target: a tap
        // meant for a reaction opened a thread. Its bottom edge also landed 2px
        // inside the next message's text. An invisible box cannot be seen
        // colliding, which is most of why it did.
        //
        // A real box cannot collide: it occupies what it claims, so everything
        // below moves down by however much this grows. It also lets a reader
        // SEE the target they are aiming at, which an `::after` never gives
        // anybody.
        'px-2 py-2 md:px-1 md:py-0.5',
        // Accent is the unread signal, and it colours the WHOLE row rather than
        // a badge on the end of it: the row is small and quiet by design, and a
        // reader scanning a long history is looking for colour, not for a
        // number they have to find first.
        unread > 0
          ? 'text-primary hover:text-primary/80 font-medium'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      <span aria-hidden className="mr-1">
        ↳
      </span>
      {/* Only the number is animated, not the words around it: a scale snap on
          the whole sentence would shift the row's width and nudge its
          neighbours. `key` remounts the span so the one-shot restarts. */}
      <span
        key={count}
        className={cn(bumped && 'motion-safe:animate-count-flip')}
        data-testid="room-thread-reply-count"
      >
        {count}
      </span>
      {count === 1 ? ' reply' : ' replies'}
      {/* The last reply's own date, carried on a `<time>` and revealed in full
          on hover — "last 9:45 AM" on a thread from last Tuesday is a clock
          reading with no day attached to it. */}
      {time.length > 0 && (
        <>
          {' · last '}
          <time dateTime={lastAt} title={formatAbsoluteTime(lastAt)}>
            {time}
          </time>
        </>
      )}
      {/* The count the accent is ABOUT, said out loud. The colour alone is a
          signal a reader has to have been taught; the words are for everybody,
          and for the screen reader that gets no colour at all. */}
      {unread > 0 && ` · ${unread} new`}
    </button>
  );
}
