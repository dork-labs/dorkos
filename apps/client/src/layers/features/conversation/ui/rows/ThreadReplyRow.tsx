/**
 * The quiet line under a thread's root — the fourth kind of row a conversation
 * can hold.
 *
 * @module features/conversation/ui/rows/ThreadReplyRow
 */
import { useState } from 'react';
import { cn } from '@/layers/shared/lib';
import type { ThreadReplySummary } from '@/layers/entities/room';
import { useConversation } from '../../model/conversation-context';
import { formatAbsoluteTime, formatTime } from '../../lib/format-entry-time';

interface ThreadReplyRowProps {
  /**
   * The DOM id to put on the row, so closing the panel can put the caret back
   * on the line that opened it. Named by the host, which owns the id scheme.
   */
  id?: string;
  /**
   * What the line says: how many replies, when the newest landed, and how many
   * of them the reader has not seen.
   *
   * Worked out by the host, because each surface knows its thread from a
   * different place: a local room from the replies it holds
   * (`threadReplySummary`), a community channel from the count its server sent
   * plus the replies that have streamed in since. The row only draws it.
   */
  summary: ThreadReplySummary;
  /** True while this thread is the one the panel is showing. */
  open: boolean;
  /** Open this thread's panel. */
  onOpen: () => void;
  /**
   * True when the message this row hangs under ends its author group. The row
   * then carries the group's end padding itself, so the message keeps its
   * replies close and the air falls after them instead of between them. A host
   * that does not say keeps the row's old tight spacing.
   */
  endsGroup?: boolean;
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
 * reader's cursor is one they have not seen, so the row renders in full ink and weight and
 * counts them. The host's summary owns that arithmetic — for a room,
 * `threadReplySummary`, which says why the cursor it reads is the frozen one.
 *
 * The reply COUNT flips when it advances (design record §5.5) — the one-shot
 * mechanical-counter snap, keyed the way `EntryReactionRow` keys its rolling
 * count: a ref seeded `null` at mount, so a row arriving with three replies
 * already on it is drawn at rest and only a genuine increment moves.
 */
export function ThreadReplyRow({ id, summary, open, onOpen, endsGroup }: ThreadReplyRowProps) {
  const { capabilities } = useConversation();
  const { count, lastAt, unread } = summary;
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
        'hover:bg-row-hover flex w-fit items-center rounded-md text-left text-xs transition-colors',
        // Its own 8px above, so the pills over it keep clear of a box this
        // tall, and the group's end padding below when it closes the group —
        // the message above gave that up so its replies sit with it.
        endsGroup === undefined ? 'mb-1' : 'mt-2',
        endsGroup === true && 'mb-[var(--msg-padding-y-end)]',
        endsGroup === false && 'mb-1',
        // **On a phone this is the ONLY way into a thread**, so it is the one
        // control down here that gets BIGGER rather than merely reaching
        // further: a 44px box below the breakpoint, 28px above it.
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
        'h-11 px-2 md:h-7',
        // Full ink and weight are the unread signal, and they mark the WHOLE
        // row rather than a badge on the end of it: the row is small and quiet
        // by design, and a reader scanning a long history is looking for the
        // line that stands out, not for a number they have to find first.
        unread > 0 ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {/* One line of text inside the flex box: a flex container would make each
          text run its own item and trim the spaces between them. */}
      <span>
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
        {/* The count the weight is ABOUT, said out loud. The weight alone is a
          signal a reader has to have been taught; the words are for everybody,
          and for the screen reader that gets no weight at all. */}
        {unread > 0 && ` · ${unread} new`}
      </span>
    </button>
  );
}
