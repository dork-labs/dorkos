import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { MessageGrouping, MessageAuthor, LongPressState } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { MarkdownContent } from '@/layers/shared/ui';
import {
  hasReacted,
  useToggleReaction,
  type AuthorRef,
  type RoomEntry,
} from '@/layers/entities/room';
import { MessageAuthorAvatar, messageItem } from '@/layers/features/chat';
import {
  EntryActionBar,
  EntryActionMenu,
  EntryReactionRow,
  useEntryActions,
  type EntryActionBarHandle,
  type RovingGroupHandle,
} from '@/layers/features/entry-actions';

interface RoomEntryRowProps {
  /** The room this entry belongs to, which its actions act on. */
  roomId: string;
  /** The durable log entry to render. */
  entry: RoomEntry;
  /** Who wrote it, resolved from the room's roster. */
  author: MessageAuthor;
  /**
   * The same author as the ROSTER holds them, or undefined once they have left.
   * Carries `mentionHandle`, which is the only string that reliably addresses
   * them — a display name routinely contains spaces and reaches nobody.
   */
  authorRef: AuthorRef | undefined;
  /** The reader's own author id here, so they are not offered to themselves. */
  viewerAuthorId: string;
  /**
   * Display names by author id, from the room's roster — the only place a
   * reaction's "You and LifeOS reacted 👍" can honestly come from.
   */
  authorNames: ReadonlyMap<string, string>;
  /** This reader's three most-used emoji, as the server counted them. */
  reactionFrequents: readonly string[];
  /**
   * True when the room's live stream has given up. Reactions go with the
   * composer: a write whose result would never come back is worse than a
   * control that says it cannot be used (design record §4).
   */
  streamStalled?: boolean;
  /** Where this entry sits in its author group. */
  grouping: MessageGrouping;
  /**
   * True when this is a reply the timeline could not place, because the entry
   * heading its thread is older than the history loaded. It renders in the
   * room's flow, so it has to say that it is answering something.
   */
  orphanedReply?: boolean;
}

/**
 * Short time display (HH:MM) for an entry's timestamp, or `''` when it is not a
 * time at all. `toLocaleTimeString` does not throw on an unparseable date — it
 * renders "Invalid Date" — so the guard has to be the parse, not a `try`.
 */
function formatTime(timestamp: string): string {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * One line of a room's history.
 *
 * A `post` renders on the same grid session chat uses — identity gutter, then
 * the content column — so a room reads as the same surface with more people in
 * it. A `notice` is the room speaking about itself, so it renders as a quiet
 * full-width line with no author beside it: attributing "Ana stopped replying
 * here" to a person would be a lie about who said it. A notice also carries no
 * actions: there is no author to mention, and nobody said it to answer.
 *
 * `orphanedReply` adds one quiet line saying the row is answering something
 * out of view. Without it a reply whose thread head has scrolled out of the
 * loaded history is indistinguishable from a new remark, which is a small lie
 * the reader has no way to catch.
 *
 * **Every post carries the action surface** — a toolbar on hover or focus, the
 * same actions on right-click, and a drawer on a long press. The row is a tab
 * stop so the toolbar can be reached without a pointer; its buttons join the
 * tab order only while focus is inside the row (see `EntryActionBar`).
 */
export function RoomEntryRow({
  roomId,
  entry,
  author,
  authorRef,
  viewerAuthorId,
  authorNames,
  reactionFrequents,
  streamStalled,
  grouping,
  orphanedReply,
}: RoomEntryRowProps) {
  const time = formatTime(entry.createdAt);
  const rowRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<EntryActionBarHandle>(null);
  const pillsRef = useRef<RovingGroupHandle>(null);
  const actions = useEntryActions({ roomId, entry, author: authorRef, viewerAuthorId });
  const toggleReaction = useToggleReaction();
  // How the touch press is going, so the message can give under the finger
  // (design record §5.6). Idle on a pointer device, which never reports one.
  const [press, setPress] = useState<LongPressState | null>(null);

  const reactions = useMemo(() => entry.reactions ?? [], [entry.reactions]);
  const mine = useMemo(
    () => reactions.filter((r) => hasReacted(r, viewerAuthorId)).map((r) => r.emoji),
    [reactions, viewerAuthorId]
  );
  const toggle = useCallback(
    (emoji: string) => toggleReaction.mutate({ roomId, entryId: entry.id, emoji, viewerAuthorId }),
    [toggleReaction, roomId, entry.id, viewerAuthorId]
  );
  const quickRow = useMemo(
    () => ({
      quick: reactionFrequents,
      mine,
      onToggle: toggle,
      disabled: streamStalled === true,
    }),
    [reactionFrequents, mine, toggle, streamStalled]
  );

  if (entry.kind === 'notice') {
    return (
      <p
        data-testid="room-notice"
        className="text-muted-foreground px-[var(--msg-padding-x)] py-2 text-xs italic"
      >
        {entry.body.text}
      </p>
    );
  }

  // A group start renders the avatar, the name and the time; a continuation
  // hangs beneath it. Derived from `grouping.position` for the same reason
  // MessageItem derives it — two sources for one fact can only drift.
  const showAuthorHeader = grouping.position === 'first' || grouping.position === 'only';
  const styles = messageItem({ position: grouping.position, anchor: 'rail' });

  /**
   * From the message itself, an arrow or Enter moves into its buttons.
   *
   * A message has two groups now and the key says which: the capsule is ABOVE
   * the message, so ArrowUp / ArrowRight / Enter reach it; the pills are BELOW,
   * so ArrowDown reaches those. A message with no reactions has no down group,
   * and ArrowDown does what it always did.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const { key } = event;
    if (key !== 'ArrowRight' && key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'Enter') return;
    event.preventDefault();
    if (key === 'ArrowDown' && reactions.length > 0) {
      pillsRef.current?.focusFirst();
      return;
    }
    barRef.current?.focusFirst();
  };

  return (
    <EntryActionMenu actions={actions} reactions={quickRow} onPressStateChange={setPress}>
      {/*
        A message is a non-interactive container that must still be focusable and
        must still hear an arrow key: it is the single tab stop its own actions
        are reached FROM, which is what keeps a room one Tab per message (see
        `EntryActionBar`). Both rules below assume the fix is to make the row
        interactive, and that is wrong here — the row holds selectable text and
        its own buttons, and neither may sit inside a control. Same shape as
        `link-safety-modal.tsx`, which handles Escape on a dialog container.
      */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- see above */}
      <div
        ref={rowRef}
        data-testid="room-entry"
        role="article"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- see above
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className={cn(
          styles.root(),
          'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
          // The press acknowledgment (design record §5.6). Touch-only in
          // practice: nothing else reports a press state. The squish is a
          // transition and the spring-back is an animation, which is what makes
          // a CANCELLED press snap back with neither — a reader who started
          // scrolling gets no celebration for the gesture they abandoned.
          'origin-center',
          press === 'pressing' && 'motion-safe:animate-press-in',
          press === 'released' && 'motion-safe:animate-press-release'
        )}
      >
        <div className={styles.gutter()}>
          {showAuthorHeader && <MessageAuthorAvatar author={author} />}
          {!showAuthorHeader && time.length > 0 && (
            <span
              className={cn(
                styles.avatarTimestamp(),
                'group-hover:text-msg-timestamp text-transparent'
              )}
            >
              {time}
            </span>
          )}
        </div>
        <div className={styles.body()}>
          {showAuthorHeader && (
            <div className={styles.header()}>
              <span className={styles.authorName()}>{author.displayName}</span>
              {time.length > 0 && (
                <span className={cn(styles.timestamp(), 'text-msg-timestamp')}>{time}</span>
              )}
            </div>
          )}
          {orphanedReply === true && (
            <p data-testid="room-entry-orphan" className="text-muted-foreground text-xs italic">
              Replying to an earlier message
            </p>
          )}
          {/*
            No carve-out for a right-click on a link. Under `linkSafety`, which
            this call site passes, every link form — markdown, autolink, bare URL
            — renders as a BUTTON that opens the link-safety modal rather than as
            an `<a href>`, so there is no native "Copy link address" here for our
            menu to be taking away. That is a property of this call site, not of
            `MarkdownContent` everywhere.
          */}
          <div data-slot="message-content" className={styles.content()}>
            <MarkdownContent content={entry.body.text} linkSafety />
          </div>
          {/* The pills, under the words they are about. A message with no
              reactions renders nothing here at all — no rail, no ghost — which
              is what keeps a quiet room quiet (design record §2, behaviour 4). */}
          <EntryReactionRow
            ref={pillsRef}
            reactions={reactions}
            viewerAuthorId={viewerAuthorId}
            names={authorNames}
            frequents={reactionFrequents}
            onToggle={toggle}
            disabled={streamStalled}
            onExit={() => rowRef.current?.focus()}
          />
          {/*
            The rail is the strip of gutter the capsule lives in — exactly one
            capsule tall, sitting directly ABOVE the message's first line, so the
            capsule straddles the message block's top edge and, for as long as
            that edge is on screen, covers no word of it (design record §1).
            `-mt` cancels its own height, so the band costs the row no vertical
            space and the message sits where it would have anyway: the capsule is
            drawn in the air between messages, not in a lane carved out for it.

            One rule, every grouping position. The band hangs off the message's
            own first line, and the row's top padding already moves with the
            grouping — so a group start (16px of padding) gets the even straddle
            the design draws, while a tight continuation (6px) reaches further up
            into the group's own 12px of air. That is the honest trade: a 30px
            capsule cannot fit in 12px, and of the two things it can overlap, the
            words of the message it ACTS ON are the ones it must never touch.

            It is also `sticky`, which is what keeps it reachable on a message
            longer than the window: it rides the message's top while that is on
            screen and clamps to the scroller's edge once the message extends
            above it. The clamp is unchanged by the band — `top-1` still pins the
            band's own top, so a clamped capsule sits exactly where it always
            did, and the handover is continuous because sticky never jumps.

            The clamp is also the one place the capsule DOES cover words: with a
            message's first line just under the scroller's edge, the pinned
            capsule sits over it. Nothing can be done about that without giving
            up either the clamp or the straddle, and the clamp is what makes a
            long message's actions reachable at all. It is a narrow band —
            roughly the capsule's own height of scroll — and off it entirely for
            the rest of the message.

            LAST in the DOM and `order-first` in the layout, deliberately. Read
            order is what a screen reader follows, and a toolbar announced ahead
            of the message would make every row open with "Reply in thread, Copy
            text" before saying who spoke or what they said — which is how session
            chat already has it, with its actions last. `order` moves the box
            without moving the reading order, and the sticky clamp is computed on
            the laid-out box, so it survives the move.

            `items-start` is load-bearing, not tidiness. A flex row's default
            `align-items: stretch` sizes a child to the line's cross size — which
            once squashed the pill to a 6px capsule with its own 24px buttons
            hanging out of it top and bottom, reading as a line ruled through the
            icons. Session chat never hit this: its `corner` anchor is
            `absolute`, so it is out of flow and no flex line ever sizes it.
            Pinned by "the toolbar encloses the buttons it is drawn around" in
            `room-entry-actions.spec.ts`.
          */}
          <div className="pointer-events-none sticky top-1 z-20 order-first -mt-(--msg-actions-height) flex h-(--msg-actions-height) items-start justify-end pr-2">
            <EntryActionBar
              ref={barRef}
              actions={actions}
              reactions={quickRow}
              onExit={() => rowRef.current?.focus()}
              className={styles.actions()}
            />
          </div>
        </div>
      </div>
    </EntryActionMenu>
  );
}
