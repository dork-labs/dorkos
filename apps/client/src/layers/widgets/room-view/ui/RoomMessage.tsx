/**
 * One row of a room's history — the shared row, wired to a channel.
 *
 * It owns what only a room knows: which of the three kinds of line an entry is,
 * who wrote it as the roster holds them, what this reader may do to it, and how
 * the row describes itself. Everything a row LOOKS like — the identity gutter,
 * the group rhythm, the author line, the hover capsule, the pills — is
 * `Message.*`, which a session transcript draws from the same code.
 *
 * A `post` renders on the message grid. A `notice` is the room speaking about
 * itself and renders as {@link NoticeRow}: a quiet full-width line with no
 * author beside it and no actions on it. A post carrying `body.moment` is a
 * milestone and renders as {@link MomentRow} — a moment is a post, so nothing
 * but the body says so.
 *
 * `orphanedReply` adds one quiet line saying the row is answering something out
 * of view. Without it a reply whose thread head has scrolled out of the loaded
 * history is indistinguishable from a new remark, which is a small lie the
 * reader has no way to catch.
 *
 * **Every post carries the action surface** — a toolbar on hover or focus, the
 * same actions on right-click, and a drawer on a long press. The row is a tab
 * stop so the toolbar can be reached without a pointer; its buttons join the tab
 * order only while focus is inside the row (see `EntryActionBar`). A fifth way
 * in, hidden and costing nothing, exists for the one reader none of those four
 * served: a screen reader on a touch screen. See `Message.Actions`.
 *
 * **The article describes itself in a line, not in full** — `entrySummary` owns
 * that line and says what it drops.
 *
 * **Every message row is NAMED, wherever it renders** — the room's feed and the
 * thread panel alike. How that name is arrived at, why a continuation row is
 * named differently, and what `feedPosition` adds to it are
 * `entryRowArticleProps`.
 *
 * @module widgets/room-view/ui/RoomMessage
 */
import { useCallback, useId, useMemo, useRef } from 'react';
import {
  useProfileDeepLink,
  type FeedPosition,
  type MessageGrouping,
  type MessageAuthor,
} from '@/layers/shared/model';
import { profileMemberIdOf, type RoomEntry } from '@/layers/entities/room';
import {
  Message,
  MomentRow,
  NoticeRow,
  attachmentsSummary,
  formatTime,
} from '@/layers/features/conversation';
import {
  useEntryActions,
  type EntryActionBarHandle,
  type RovingGroupHandle,
} from '@/layers/features/entry-actions';
import { entryRowArticleProps } from '../lib/entry-row-article';
import { entrySummary } from '../lib/entry-summary';
import { roomEntryRowKind, toMessageAuthor, type RosterAuthor } from '../lib/room-timeline';
import { useAgentInfo, useRoomAgentFaces } from '../model/agent-info-context';
import { useEntryReactions } from '../model/use-entry-reactions';
import { useEntryRowKeys } from '../model/use-entry-row-keys';
import { makeRoomBodyRenderer } from './render-room-body';

interface RoomMessageProps {
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

/** One line of a room's history. */
export function RoomMessage({
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
}: RoomMessageProps) {
  const time = formatTime(entry.createdAt);
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

  const { reactions, toggle, quickRow } = useEntryReactions({
    roomId,
    entry,
    viewerAuthorId,
    reactionFrequents,
    streamStalled,
    isMember,
  });
  // Where this row's own face leads, in ROSTER ids — the same two-space join a
  // mention pill in the body makes, and made in the same place for the same
  // reason: the row is the part that holds both the roster author and the fleet
  // answer. An author who has left the room, the room's own voice, and an agent
  // the fleet could not name all resolve to `undefined`, and the gutter draws
  // plain art rather than a control that opens an empty profile.
  const authorAgent = useAgentInfo(authorRef?.agentRef);
  const { open: openProfile } = useProfileDeepLink();
  const profileMemberId =
    authorRef === undefined ? undefined : profileMemberIdOf(authorRef, authorAgent?.memberId);
  // Stable across renders, because the action set memoises on it: a fresh
  // closure each pass would rebuild every message's capsule on every render of
  // the feed.
  const openAuthorProfile = useCallback(() => {
    if (profileMemberId !== undefined) openProfile(profileMemberId);
  }, [openProfile, profileMemberId]);
  const viewAuthorProfile = profileMemberId === undefined ? undefined : openAuthorProfile;
  // The capsule carries the same destination as the face, which is what lets the
  // face stay out of the tab order — see `EntryActionsInput.onViewProfile`.
  const actions = useEntryActions({
    roomId,
    entry,
    author: authorRef,
    viewerAuthorId,
    onViewProfile: viewAuthorProfile,
  });
  const handleKeyDown = useEntryRowKeys({
    barRef,
    pillsRef,
    hasReactions: reactions.length > 0,
  });
  const focusRow = useCallback(() => rowRef.current?.focus(), []);
  const renderBody = useMemo(() => makeRoomBodyRenderer(authors), [authors]);
  // Who a MOMENT is about, resolved here because only the host can reach both
  // the room's roster and the fleet — see `MomentRow`, which takes the answer as
  // a prop for that reason. Computed for every row rather than inside the moment
  // branch, because hooks may not hang off which kind of line this is.
  const faces = useRoomAgentFaces();
  const subjectId = entry.body.subjectAuthorId ?? entry.authorId;
  const subjectRef = authors.get(subjectId);
  const subjectAgent = useAgentInfo(subjectRef?.agentRef);

  // Which of the three lines this is — read once, from `roomEntryRowKind`,
  // which is also what `conversation-row-kinds.test.ts` puts every kind of
  // entry through. A moment is a POST, so `kind` alone cannot tell it apart
  // from somebody talking; the rule lives in one place rather than here and
  // in the test's idea of here.
  const rowKind = roomEntryRowKind(entry);

  if (rowKind.kind === 'notice') {
    return <NoticeRow entry={entry} feedPosition={feedPosition} rowId={rowId} />;
  }

  // Everything else about a moment's row still applies: it is on the same log,
  // at the same seq, in the same feed.
  if (rowKind.kind === 'moment') {
    return (
      <MomentRow
        entry={entry}
        moment={rowKind.moment}
        subject={subjectId === entry.authorId ? author : toMessageAuthor(subjectId, authors, faces)}
        subjectIdentity={{
          handle: subjectRef?.handle ?? undefined,
          origin: subjectRef?.origin,
          // A chip per fact the roster actually resolved, and nothing at all
          // for one it did not — never an invented runtime.
          agent: subjectAgent && {
            runtime: subjectAgent.runtime,
            ...(subjectAgent.model && { model: subjectAgent.model }),
          },
        }}
        feedPosition={feedPosition}
        rowId={rowId}
      />
    );
  }

  // A group start renders the avatar, the name and the time; a continuation
  // hangs beneath it. Derived from `grouping.position` inside the row family,
  // for the same reason it always was — two sources for one fact can only drift.
  const showAuthorHeader = grouping.position === 'first' || grouping.position === 'only';

  return (
    <Message.Root
      ref={rowRef}
      id={rowId}
      position={grouping.position}
      actions={actions}
      reactions={quickRow}
      data-testid="room-entry"
      /*
        A message is a non-interactive container that must still be focusable and
        must still hear an arrow key: it is the single tab stop its own actions
        are reached FROM, which is what keeps a room one Tab per message (see
        `EntryActionBar`). The a11y rules that would object here — a tab stop and
        a key handler on a non-interactive element — both assume the fix is to
        make the row interactive, and that is wrong: the row holds selectable
        text and its own buttons, and neither may sit inside a control. Same
        shape as `link-safety-modal.tsx`, which handles Escape on a dialog
        container. (They no longer fire at all, because the row is drawn by a
        component rather than a bare `div` — the reasoning is kept because the
        decision is still the decision.)
      */
      tabIndex={0}
      // How the row names and describes itself, and where it sits in the feed —
      // one decision, in `entryRowArticleProps`, which also says why there is no
      // `aria-keyshortcuts` on a room's messages.
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
    >
      <Message.Gutter
        author={author}
        at={entry.createdAt}
        onViewProfile={viewAuthorProfile}
        isSelf={entry.authorId === viewerAuthorId}
      />
      <Message.Body>
        <Message.Author
          id={headerId}
          author={author}
          at={entry.createdAt}
          origin={authorRef?.origin}
        />
        {orphanedReply === true && (
          <p data-testid="room-entry-orphan" className="text-muted-foreground text-xs italic">
            Replying to an earlier message
          </p>
        )}
        <Message.Content
          id={contentId}
          // A long unbroken token — a URL, a file path, a hash pasted as
          // `code` — is wider than the column and had nowhere to go: the column
          // is `min-w-0`, so the overflow was simply clipped and the end of the
          // token was unreadable and unselectable. Inline code breaks mid-token,
          // which is right for something that is not prose; a fenced block
          // scrolls instead, because breaking a line of code changes what it
          // says.
          className="[&_:not(pre)>code]:wrap-anywhere [&_pre]:overflow-x-auto"
        >
          {renderBody(entry, { rowId: entry.id, isStreaming: false })}
        </Message.Content>
        {summary !== null && (
          /*
            The article's description, for a message too long or too code-heavy
            to be its own — and deliberately `display:none`.

            A description is resolved from the element it points AT whether or
            not that element is displayed, which is what makes this the one
            place a summary can live without also being read twice: `sr-only`
            would put it back in the row's own contents, so a screen reader
            would hear the summary and then the message.
          */
          <span id={summaryId} className="hidden">
            {summary}
          </span>
        )}
        {/* The files that came with the message, under the words and above
            the pills. An entry with none — including every entry written
            before rooms carried files at all — renders nothing here. */}
        <Message.Attachments items={entry.attachments ?? []} />
        {/* The pills, under the words they are about. A message with no
            reactions renders nothing here at all — no rail, no ghost — which
            is what keeps a quiet room quiet (design record §2, behaviour 4). */}
        <Message.Reactions
          ref={pillsRef}
          reactions={reactions}
          viewerAuthorId={viewerAuthorId}
          names={authorNames}
          frequents={reactionFrequents}
          onToggle={toggle}
          disabled={streamStalled === true || !isMember}
          onExit={focusRow}
        />
        {/* "Reply in thread" stays offered even here: it only opens the
            thread panel, and that panel's own composer is the SAME
            `ChannelComposer` the room's own composer is — it already refuses
            to post once `isMember` is false (DOR-1233), so a room you left
            cannot be replied into through this door either. "Copy text"
            reads the message, not the room, so membership is not its
            business at all. */}
        <Message.Actions actions={actions} reactions={quickRow} barRef={barRef} onExit={focusRow} />
      </Message.Body>
    </Message.Root>
  );
}
