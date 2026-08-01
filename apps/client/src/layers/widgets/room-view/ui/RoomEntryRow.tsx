import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  CircleSlash,
  CircleStop,
  Gauge,
  Hand,
  Hourglass,
  Info,
  Megaphone,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { RoomNoticeCode } from '@dorkos/shared/room-schemas';
import {
  feedArticleProps,
  type FeedPosition,
  type MessageGrouping,
  type MessageAuthor,
  type LongPressState,
} from '@/layers/shared/model';
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
  /**
   * Where this row sits in the feed it is rendering inside — the room's flow,
   * or an open thread's root and replies.
   *
   * Counted per feed, never across both: a thread's replies are numbered in the
   * panel that navigates them and are not part of the room's set, because a
   * position in a set nothing walks is a promise of Page Down that no container
   * keeps. Omitted where a row renders outside a feed entirely, which leaves it
   * named but unnumbered.
   */
  feedPosition?: FeedPosition;
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
 * How each kind of notice is drawn.
 *
 * The room speaks in its own voice about several different things and used to
 * draw them all identically — one italic muted line, with `body.notice` read by
 * nothing anywhere in the client. So "your agent hit an error and could not
 * answer" looked exactly like "this room widened who answers here", and a
 * reader skimming had no way to tell a problem from an aside without reading
 * every line in full.
 *
 * A mark each, and a tone for the two that need one. **Warm is reserved for a
 * line that wants the reader to DO something** — `turn_failed`, where the
 * answer is not coming, and `awaiting_approval`, where the agent has stopped
 * and cannot go on until somebody answers it. Everything else is the room
 * working as designed and saying so, and a column of amber over a busy
 * afternoon would teach a reader to stop looking. The mark is what tells them
 * apart at a glance; the colour is what says one of them is waiting on you.
 *
 * The WORDS are never touched here. The server owns them (`room-notices.ts`)
 * and writes them for a person who did not configure this room; a second
 * sentence invented at the render would be a second voice saying the same thing
 * slightly differently.
 */
const NOTICE_STYLES: Record<RoomNoticeCode, { Icon: LucideIcon; tone?: string }> = {
  // Something went wrong and the answer is not coming.
  turn_failed: { Icon: TriangleAlert, tone: 'text-status-warning' },
  // Occupied, not broken — and the message has to be sent again.
  agent_busy: { Icon: Hourglass },
  // Stopped, and waiting for THIS reader to do something about it. Warm like
  // `turn_failed`, and for the same reason: both are lines a person has to act
  // on, and the rest are the room reporting that it is working as designed.
  awaiting_approval: { Icon: Hand, tone: 'text-status-warning' },
  // Somebody stopped everything here, on purpose.
  halted: { Icon: CircleStop },
  // A cap was reached. Nothing is wrong; the room is doing what it was told.
  budget_reached: { Icon: Gauge },
  // A back-and-forth reached its depth and stopped itself.
  cascade_stopped: { Icon: CircleSlash },
  // DorkOS changed when the agents here answer, and has to admit it.
  addressing_changed: { Icon: Megaphone },
};

/** The mark on a notice whose code this client does not recognise. */
const UNKNOWN_NOTICE: { Icon: LucideIcon; tone?: string } = { Icon: Info };

/** How much of a notice its name carries before it is cut short. */
const NOTICE_NAME_MAX = 80;

/**
 * A notice's own words, short enough to be a name.
 *
 * Cut on a word boundary where there is one within reach, so the name ends
 * mid-sentence rather than mid-word — a name is spoken, and a chopped word is
 * heard as a mistake.
 *
 * @param text - What the notice says.
 */
function noticeName(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= NOTICE_NAME_MAX) return trimmed;
  const cut = trimmed.slice(0, NOTICE_NAME_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > NOTICE_NAME_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
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
 *
 * **Every message row is NAMED, wherever it renders** — the room's feed and the
 * thread panel alike. That is the decision, not a side effect of the feed work
 * that happened to leak: a message that cannot say who wrote it is a message a
 * screen reader can only reach by reading everything around it, and that is as
 * true in a thread as it is in a room.
 *
 * A row shipped unnamed on purpose once, and the reason it changed is worth
 * keeping. "Message from Ana" over a row that visibly says "Ana" is a second
 * sentence invented for screen readers — the DOR-583 double-speak. The answer
 * is not to stay silent but to stop inventing: the name is the author line
 * ALREADY ON SCREEN, pointed at with `aria-labelledby`, so what repeats is the
 * visible line and never a string written for the purpose. The APG's own feed
 * example resolves it the same way.
 *
 * A continuation row is the exception and gets an `aria-label` instead: it has
 * no author line to point at, because the design deliberately drops one for a
 * run of messages from the same person. Sighted readers get that from the
 * grouping; a name is how everyone else gets the same fact.
 *
 * `feedPosition` is a CONSUMER of that name rather than its cause. It adds
 * where the row sits in the set, which is what makes Page Down say "12 of 30,
 * Ana" — so a row outside a feed is named but unnumbered, and the same row is
 * numbered differently in the room's flow and in an open thread's panel, which
 * are two feeds and two sets.
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
  feedPosition,
}: RoomEntryRowProps) {
  const time = formatTime(entry.createdAt);
  const domId = useId();
  const headerId = `${domId}-author`;
  const contentId = `${domId}-content`;
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
    // An article like any other line of the log, and a stop the feed can land
    // on. Leaving it out of the set would make Page Down skip the room saying
    // something about itself — which is exactly the kind of line a reader who
    // is not watching the screen most needs to be given.
    //
    // Named from its OWN words, not a fixed "Room notice". An `aria-label`
    // REPLACES the element's text for naming purposes, so a shared label over a
    // one-line paragraph is a live hazard: land on it and the only thing
    // guaranteed to be announced is the label, which would turn "Ana stopped
    // replying here" into three words that say nothing. Naming it after its own
    // text means the worst case is hearing the line twice rather than never.
    const { Icon, tone } =
      (entry.body.notice && NOTICE_STYLES[entry.body.notice]) ?? UNKNOWN_NOTICE;
    return (
      <p
        data-testid="room-notice"
        data-notice={entry.body.notice ?? 'unknown'}
        {...(feedPosition && { role: 'article', 'aria-label': noticeName(entry.body.text) })}
        {...feedArticleProps(feedPosition)}
        className={cn(
          'focus-visible:ring-ring/50 flex items-start gap-2 px-[var(--msg-padding-x)] py-2 text-xs outline-none focus-visible:ring-2',
          tone ?? 'text-muted-foreground'
        )}
      >
        {/* Decoration, and it has to stay decoration: the words beside it already
            say everything the mark stands for, and naming the icon would make a
            screen reader read "warning" before a sentence that goes on to
            explain itself. */}
        <Icon aria-hidden className="mt-px size-3.5 shrink-0" />
        <span>{entry.body.text}</span>
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
   * A message has two groups and the key says which: ArrowRight and Enter reach
   * the capsule above it, ArrowDown reaches the pills below it. A message with
   * no pills has no down group, and then **ArrowDown is left alone** — it
   * scrolls, which is what an arrow key on a page of text is for.
   *
   * That is the difference from how the row shipped, and it is deliberate
   * (DOR-757, N-f). ArrowUp and ArrowDown used to be swallowed into the capsule
   * by every message, so a keyboard reader who focused a message longer than the
   * window could not scroll through it without leaving the message first. The
   * capsule keeps two ways in that nothing else wants, and the arrows go back to
   * the reader.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const { key } = event;
    if (key === 'ArrowDown' && reactions.length > 0) {
      event.preventDefault();
      pillsRef.current?.focusFirst();
      return;
    }
    if (key !== 'ArrowRight' && key !== 'Enter') return;
    event.preventDefault();
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
        // Named from the author line already on screen, or — for a continuation
        // row, which has none — from the same two facts said directly. Either
        // way it is who spoke and when, never a sentence about the row itself.
        {...(showAuthorHeader
          ? { 'aria-labelledby': headerId }
          : {
              'aria-label': time.length > 0 ? `${author.displayName}, ${time}` : author.displayName,
            })}
        // What the article is ABOUT, which the APG asks a feed's articles to
        // point at: the words, not the toolbar drawn over them.
        aria-describedby={contentId}
        // The capsule is reached with an arrow or Enter and announced by
        // nothing — a roving group is invisible until you are standing in it.
        // Enter is the one worth saying out loud.
        aria-keyshortcuts="Enter"
        {...feedArticleProps(feedPosition)}
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
            <div id={headerId} className={styles.header()}>
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
          <div id={contentId} data-slot="message-content" className={styles.content()}>
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
