/**
 * One row of a room's history — the composition root.
 *
 * It owns what only the whole row can: which of the two kinds of line an entry
 * is, the single tab stop, and the grid a post is laid out on. Every part that
 * can be owned alone lives beside this file — the notice line, who spoke and
 * when, the words, the files posted with them, the action surface, the reaction
 * arithmetic, and what the row tells a screen reader about itself.
 *
 * @module widgets/room-view/ui/RoomEntryRow
 */
import { useId, useMemo, useRef, useState } from 'react';
import {
  type FeedPosition,
  type MessageGrouping,
  type MessageAuthor,
  type LongPressState,
} from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import type { RoomEntry } from '@/layers/entities/room';
import { messageItem } from '@/layers/features/chat';
import {
  EntryActionMenu,
  EntryReactionRow,
  useEntryActions,
  type EntryActionBarHandle,
  type RovingGroupHandle,
} from '@/layers/features/entry-actions';
import { entryRowArticleProps } from '../lib/entry-row-article';
import { entrySummary } from '../lib/entry-summary';
import { formatAbsoluteTime, formatTime } from '../lib/entry-time';
import type { RosterAuthor } from '../lib/room-timeline';
import { useEntryReactions } from '../model/use-entry-reactions';
import { useEntryRowKeys } from '../model/use-entry-row-keys';
import { RoomEntryActions } from './RoomEntryActions';
import { RoomEntryAttachments, attachmentsSummary } from './RoomEntryAttachments';
import { RoomEntryBody } from './RoomEntryBody';
import { RoomEntryAuthorLine, RoomEntryGutter } from './RoomEntryHeader';
import { RoomMomentRow } from './RoomMomentRow';
import { RoomNoticeRow } from './RoomNoticeRow';

interface RoomEntryRowProps {
  /** The room this entry belongs to, which its actions act on. */
  roomId: string;
  /** The durable log entry to render. */
  entry: RoomEntry;
  /** Who wrote it, resolved from the room's roster. */
  author: MessageAuthor;
  /**
   * The same author as the ROSTER holds them, or undefined once they have left.
   * Carries `handle`, which is the only string that reliably addresses
   * them — a display name routinely contains spaces and reaches nobody — and
   * `origin`, which is what draws the origin mark beside an external author's
   * name (chats-as-channels spec §4.3, §9).
   */
  authorRef: RosterAuthor | undefined;
  /**
   * The room's whole roster, keyed by author id — how a `<mention>` spliced
   * into the body (`mention-markup.ts`) resolves to who it names. The same
   * map `authorRef` above is drawn from one entry of; a mention needs the
   * whole thing because it can name anybody in the room, not just this row's
   * own author.
   */
  authors: ReadonlyMap<string, RosterAuthor>;
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
  /**
   * Whether the viewer is on this room's roster right now. Reactions go with
   * the composer for this reason too (DOR-1233): the owner sees every room
   * on the install whether or not they are a member of it, and a reaction on
   * one they left refuses the identical `MEMBER_NOT_FOUND` a post does.
   * Defaults `true` so a caller that has not resolved membership yet — none
   * does today — still gets a live row rather than a silently dead one.
   */
  isMember?: boolean;
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
  /**
   * The DOM id to put on the row, when something has to be able to find it
   * again.
   *
   * Only the room's own timeline passes one. The same entry can be on screen
   * TWICE — a thread's root renders in the room's flow and again at the head of
   * the open panel — and two elements answering to one id is a lookup whose
   * answer depends on document order. The timeline's copy is the one focus
   * comes back to, so the timeline is the one that names it.
   */
  rowId?: string;
}

/**
 * One line of a room's history.
 *
 * A `post` renders on the same grid session chat uses — identity gutter, then
 * the content column — so a room reads as the same surface with more people in
 * it. A `notice` is the room speaking about itself and renders as
 * {@link RoomNoticeRow}: a quiet full-width line with no author beside it and
 * no actions on it. A post carrying `body.moment` is a milestone and renders as
 * {@link RoomMomentRow} — a moment is a post, so nothing but the body says so.
 *
 * `orphanedReply` adds one quiet line saying the row is answering something
 * out of view. Without it a reply whose thread head has scrolled out of the
 * loaded history is indistinguishable from a new remark, which is a small lie
 * the reader has no way to catch.
 *
 * **Every post carries the action surface** — a toolbar on hover or focus, the
 * same actions on right-click, and a drawer on a long press. The row is a tab
 * stop so the toolbar can be reached without a pointer; its buttons join the
 * tab order only while focus is inside the row (see `EntryActionBar`). A fifth
 * way in, hidden and costing nothing, exists for the one reader none of those
 * four served: a screen reader on a touch screen. See {@link RoomEntryActions}.
 *
 * **The article describes itself in a line, not in full** — see
 * {@link RoomEntryBody}, which draws both the words and the line that stands in
 * for them where they are too long or too code-heavy to describe themselves.
 *
 * **Every message row is NAMED, wherever it renders** — the room's feed and the
 * thread panel alike. That is the decision, not a side effect of the feed work
 * that happened to leak: a message that cannot say who wrote it is a message a
 * screen reader can only reach by reading everything around it, and that is as
 * true in a thread as it is in a room. How that name is arrived at, why a
 * continuation row is named differently, and what `feedPosition` adds to it are
 * `entryRowArticleProps`.
 */
export function RoomEntryRow({
  roomId,
  entry,
  author,
  authorRef,
  authors,
  viewerAuthorId,
  authorNames,
  reactionFrequents,
  streamStalled,
  isMember = true,
  grouping,
  orphanedReply,
  feedPosition,
  rowId,
}: RoomEntryRowProps) {
  const time = formatTime(entry.createdAt);
  const absoluteTime = formatAbsoluteTime(entry.createdAt);
  // `null` for a message that already reads as one line — see `entrySummary`.
  // Memoised on the text: six passes over a message body is not much, but it is
  // six passes per row per render of a feed that re-renders on every arriving
  // reaction, and the answer only changes when the words do.
  //
  // Files posted with the message join that ONE line rather than getting an
  // `aria-describedby` of their own. The attachments block is a sibling of the
  // rendered body, so a description pointing at the body says nothing about
  // it — a reader crossing the room would hear the words and never learn a file
  // came with them. A message with no files is untouched, `null` and all.
  const summary = useMemo(() => {
    const said = entrySummary(entry.body.text);
    const files = attachmentsSummary(entry.attachments ?? []);
    if (files === null) return said;
    // `entrySummary` answers `null` for a message short enough to be its own
    // description, and a description can only point at one element — so where
    // there are files the row needs a written line, and the raw body is what
    // that `null` says the words already are.
    const spoken = said ?? entry.body.text.trim();
    return spoken.length > 0 ? `${spoken} ${files}` : files;
  }, [entry.body.text, entry.attachments]);
  const domId = useId();
  const headerId = `${domId}-author`;
  const contentId = `${domId}-content`;
  const summaryId = `${domId}-summary`;
  const rowRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<EntryActionBarHandle>(null);
  const pillsRef = useRef<RovingGroupHandle>(null);
  const actions = useEntryActions({ roomId, entry, author: authorRef, viewerAuthorId });
  // How the touch press is going, so the message can give under the finger
  // (design record §5.6). Idle on a pointer device, which never reports one.
  const [press, setPress] = useState<LongPressState | null>(null);
  const { reactions, toggle, quickRow } = useEntryReactions({
    roomId,
    entry,
    viewerAuthorId,
    reactionFrequents,
    streamStalled,
    isMember,
  });
  const handleKeyDown = useEntryRowKeys({
    barRef,
    pillsRef,
    hasReactions: reactions.length > 0,
  });

  if (entry.kind === 'notice') {
    return <RoomNoticeRow entry={entry} feedPosition={feedPosition} rowId={rowId} />;
  }

  // A moment is a POST that marks something that really happened, so `kind`
  // cannot tell it apart from an ordinary message — `body.moment` is the tell,
  // and a client that only read `kind` would draw a milestone as somebody
  // talking. Everything else about the row still applies: it is on the same
  // log, at the same seq, in the same feed.
  if (entry.body.moment) {
    return (
      <RoomMomentRow
        entry={entry}
        moment={entry.body.moment}
        author={author}
        authors={authors}
        feedPosition={feedPosition}
        rowId={rowId}
      />
    );
  }

  // A group start renders the avatar, the name and the time; a continuation
  // hangs beneath it. Derived from `grouping.position` for the same reason
  // MessageItem derives it — two sources for one fact can only drift.
  const showAuthorHeader = grouping.position === 'first' || grouping.position === 'only';
  const styles = messageItem({ position: grouping.position, anchor: 'rail' });

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
        id={rowId}
        data-testid="room-entry"
        role="article"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- see above
        tabIndex={0}
        // How the row names and describes itself, and where it sits in the feed
        // — one decision, in `entryRowArticleProps`, which also says why there
        // is no `aria-keyshortcuts` on a room's messages.
        {...entryRowArticleProps({
          showAuthorHeader,
          headerId,
          displayName: author.displayName,
          time,
          summary,
          contentId,
          summaryId,
          feedPosition,
        })}
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
          // iOS answers a long press on text with its own selection callout, so
          // the press meant to open this message's drawer summoned Apple's
          // "Copy / Look Up" bubble on top of it — two menus for one gesture,
          // and the wrong one in front. The words stay selectable; only the
          // callout is refused, and the drawer carries a Copy text of its own.
          '[-webkit-touch-callout:none]',
          press === 'pressing' && 'motion-safe:animate-press-in',
          press === 'released' && 'motion-safe:animate-press-release'
        )}
      >
        <RoomEntryGutter
          author={author}
          showAuthorHeader={showAuthorHeader}
          createdAt={entry.createdAt}
          time={time}
          absoluteTime={absoluteTime}
          className={styles.gutter()}
          timestampClassName={styles.avatarTimestamp()}
        />
        <div className={styles.body()}>
          {showAuthorHeader && (
            <RoomEntryAuthorLine
              id={headerId}
              author={author}
              authorRef={authorRef}
              createdAt={entry.createdAt}
              time={time}
              absoluteTime={absoluteTime}
              className={styles.header()}
              nameClassName={styles.authorName()}
              timestampClassName={styles.timestamp()}
            />
          )}
          {orphanedReply === true && (
            <p data-testid="room-entry-orphan" className="text-muted-foreground text-xs italic">
              Replying to an earlier message
            </p>
          )}
          <RoomEntryBody
            entry={entry}
            authors={authors}
            contentId={contentId}
            summary={summary}
            summaryId={summaryId}
            className={styles.content()}
          />
          {/* The files that came with the message, under the words and above
              the pills. An entry with none — including every entry written
              before rooms carried files at all — renders nothing here. */}
          <RoomEntryAttachments attachments={entry.attachments ?? []} />
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
            disabled={streamStalled === true || !isMember}
            onExit={() => rowRef.current?.focus()}
          />
          {/* "Reply in thread" stays offered even here: it only opens the
              thread panel, and that panel's own composer is the SAME
              `RoomComposer` the room's own composer is — it already refuses
              to post once `isMember` is false (DOR-1233), so a room you left
              cannot be replied into through this door either. "Copy text"
              reads the message, not the room, so membership is not its
              business at all. */}
          <RoomEntryActions
            actions={actions}
            reactions={quickRow}
            barRef={barRef}
            onExit={() => rowRef.current?.focus()}
            className={styles.actions()}
          />
        </div>
      </div>
    </EntryActionMenu>
  );
}
