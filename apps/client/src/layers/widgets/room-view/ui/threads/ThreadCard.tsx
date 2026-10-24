/**
 * One thread on the Threads page: where it is, what it hangs off, the newest
 * replies, and a box to answer in.
 *
 * @module widgets/room-view/ui/threads/ThreadCard
 */
import { useMemo, useState, type MouseEvent } from 'react';
import type { RoomEntry, RoomWithRoster, ThreadSummary } from '@dorkos/shared/room-schemas';
import { cn } from '@/layers/shared/lib';
import { Skeleton } from '@/layers/shared/ui';
import { isRoomMember, roomDisplayTitle, usePendingPosts, useRoom } from '@/layers/entities/room';
import { Conversation, PendingRow } from '@/layers/features/conversation';
import { authorsById, displayAuthorIdOf, toMessageAuthor } from '../../lib/room-timeline';
import { AgentInfoProvider, type RoomAgentDirectory } from '../../model/agent-info-context';
import { ROOM_CAPABILITIES } from '../../model/room-capabilities';
import { useRoomTarget } from '../../model/room-target';
import { useThreadCardEntries } from '../../model/use-thread-card';
import { ChannelComposer } from '../ChannelComposer';
import { RoomMessage } from '../RoomMessage';

/**
 * Whether a click on the message the thread hangs off is a request to open the
 * thread — anything but a press on one of the message's own controls (a
 * reaction, a link, its action bar) or the end of a text selection.
 *
 * @param event - The click.
 */
function opensThread(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target as HTMLElement;
  if (target.closest('button, a, input, textarea, [role="button"], [role="menuitem"]')) {
    return false;
  }
  return (window.getSelection()?.toString() ?? '') === '';
}

/** Props for {@link ThreadCard}. */
export interface ThreadCardProps {
  /** The thread, as the cross-room list describes it. */
  thread: ThreadSummary;
  /** The fleet's faces and run modes, read once for the whole page. */
  agents: RoomAgentDirectory;
  /** Open this thread in its room. */
  onOpen: (thread: ThreadSummary) => void;
}

/**
 * A card for one thread.
 *
 * **The room's own pieces, never a copy of them.** The root and the replies are
 * {@link RoomMessage}s, the box is the room's {@link ChannelComposer} aimed at
 * this thread, and a reply in flight is the room's {@link PendingRow} — so a
 * message on this page looks and behaves exactly as it does in the room.
 *
 * **The box opens on demand.** A page of fifty threads with fifty live
 * composers would hold fifty editors nobody is typing in, so each card starts
 * with a quiet "Reply…" that turns into the real composer, caret in it, when
 * pressed.
 *
 * Pressing the room's name, the message the thread hangs off, or "N more
 * replies" opens the thread in its room — beside the room on a wide screen, as
 * a sheet over it on a phone.
 */
export function ThreadCard({ thread, agents, onOpen }: ThreadCardProps) {
  const roomQuery = useRoom(thread.roomId);
  const room = roomQuery.data;
  const title = roomDisplayTitle({
    kind: thread.roomKind,
    slug: thread.roomSlug,
    title: thread.roomTitle,
  });

  return (
    <article
      aria-label={`Thread in ${title}`}
      data-testid="thread-card"
      data-thread-root={thread.rootEntryId}
      className="bg-card rounded-lg border"
    >
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <button
          type="button"
          onClick={() => onOpen(thread)}
          className={cn(
            'focus-ring hover:text-foreground min-w-0 truncate rounded text-sm',
            thread.unreadCount > 0 ? 'text-foreground font-semibold' : 'text-muted-foreground'
          )}
        >
          {title}
        </button>
        {thread.unreadCount > 0 && (
          <span className="text-primary shrink-0 text-xs font-medium">
            {thread.unreadCount} new
          </span>
        )}
      </header>
      {room === undefined ? (
        <ThreadCardBodySkeleton />
      ) : (
        <ThreadCardBody room={room} thread={thread} agents={agents} onOpen={onOpen} />
      )}
    </article>
  );
}

/** The card's messages and box, once its room has answered. */
function ThreadCardBody({
  room,
  thread,
  agents,
  onOpen,
}: {
  room: RoomWithRoster;
  thread: ThreadSummary;
  agents: RoomAgentDirectory;
  onOpen: (thread: ThreadSummary) => void;
}) {
  const { root, latest, loaded } = useThreadCardEntries(room.id, thread.rootEntryId);
  // The thread's own target: a reply typed here goes to THIS thread, exactly
  // as one typed in the room's thread panel does.
  const threadTarget = useRoomTarget({ room, threadRootId: thread.rootEntryId });
  const pending = usePendingPosts(room.id, thread.rootEntryId);
  const [replying, setReplying] = useState(false);
  const isMember = isRoomMember(room.members, room.viewerAuthorId);
  const authors = useMemo(
    () => authorsById(room.members, room.formerAuthors),
    [room.members, room.formerAuthors]
  );
  const authorNames = useMemo(
    () => new Map([...authors].map(([id, author]) => [id, author.displayName])),
    [authors]
  );
  // The server's count, not the loaded replies': a long thread's older replies
  // are further back than the page the room read.
  const more = Math.max(0, thread.replyCount - latest.length);

  const message = (entry: RoomEntry) => (
    <RoomMessage
      key={entry.id}
      roomId={room.id}
      entry={entry}
      author={toMessageAuthor(displayAuthorIdOf(entry, authors), authors, agents.faces)}
      authorRef={authors.get(entry.authorId)}
      authors={authors}
      viewerAuthorId={room.viewerAuthorId}
      authorNames={authorNames}
      reactionFrequents={room.reactionFrequents}
      isMember={isMember}
      grouping={{ position: 'only' }}
    />
  );

  return (
    <AgentInfoProvider known={agents}>
      <Conversation.Root
        surface="room"
        capabilities={ROOM_CAPABILITIES}
        target={threadTarget.target}
        anchor="rail"
      >
        <div className="py-2">
          {root !== undefined ? (
            // The message is a feed article with its own controls, so it cannot
            // sit inside a button. A press anywhere on it that is not one of
            // those controls opens the thread; the room's name above is the
            // same door for a keyboard.
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- see above
            <div
              data-testid="thread-card-root"
              className="cursor-pointer"
              onClick={(event) => {
                if (opensThread(event)) onOpen(thread);
              }}
            >
              {message(root)}
            </div>
          ) : (
            // The root is older than the page the room read, or gone. The list
            // still carries its opening words, so the card says those rather
            // than nothing.
            <button
              type="button"
              onClick={() => onOpen(thread)}
              className="focus-ring text-foreground hover:bg-accent/40 mx-2 block w-[calc(100%-1rem)] rounded px-2 py-1.5 text-left text-sm"
            >
              {loaded ? (
                thread.rootPreview || 'A message with no text'
              ) : (
                <Skeleton className="h-4 w-2/3" />
              )}
            </button>
          )}
          {more > 0 && (
            <button
              type="button"
              data-testid="thread-card-more"
              onClick={() => onOpen(thread)}
              className="focus-ring text-muted-foreground hover:text-foreground mx-[var(--msg-padding-x)] my-1 rounded text-xs"
            >
              {more === 1 ? '1 more reply' : `${more} more replies`}
            </button>
          )}
          {latest.map(message)}
          {pending.map((post) => (
            <PendingRow key={post.clientId} post={post} viewerAuthorId={room.viewerAuthorId} />
          ))}
        </div>
        {isMember && (
          <div className="border-t">
            {replying ? (
              <ChannelComposer
                room={room}
                threadRootId={thread.rootEntryId}
                attachments={threadTarget.attachments}
                focusOnMount
              />
            ) : (
              <button
                type="button"
                data-testid="thread-card-reply"
                onClick={() => setReplying(true)}
                className="focus-ring text-muted-foreground hover:text-foreground w-full rounded-b-lg px-4 py-2.5 text-left text-sm"
              >
                Reply…
              </button>
            )}
          </div>
        )}
      </Conversation.Root>
    </AgentInfoProvider>
  );
}

/** What a card shows while its room is still being read. */
function ThreadCardBodySkeleton() {
  return (
    <div className="flex flex-col gap-2 px-4 py-3" aria-hidden>
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-4 w-4/5" />
    </div>
  );
}
