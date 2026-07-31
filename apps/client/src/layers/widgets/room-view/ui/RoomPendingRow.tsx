import { Loader2, TriangleAlert } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import {
  usePendingPostStore,
  usePostToRoom,
  useReplyInThread,
  type PendingPost,
} from '@/layers/entities/room';

interface RoomPendingRowProps {
  /** The message that has been sent and not yet come back. */
  post: PendingPost;
}

/**
 * A message of your own, waiting for the room to say it back.
 *
 * **Why anything is drawn here at all.** A post is trigger-only: the entry
 * arrives on the room's stream, not in the response. Between pressing Enter and
 * that echo there was nothing on screen — the composer had already taken the
 * words and cleared itself — so on a slow link a sentence simply disappeared for
 * the round trip, and under a stream that had stopped listening it disappeared
 * for good, with the composer still cheerfully accepting the next one.
 *
 * It sits at the TAIL of the conversation, where the message is about to appear,
 * rather than in a status area somewhere else: the point is that the sentence is
 * still there, in the place it was going.
 *
 * **Two states, and the second one is the one that matters.** In flight it is
 * the same words at the same place, dimmed, with a quiet spinner — nothing to
 * read, nothing to do. Refused, it says so and offers the two things a person
 * actually wants: send it again, or throw it away. Nothing here can lose the
 * words without somebody choosing to.
 *
 * The retry re-fires the same mutation with the same client id, so the row moves
 * back into flight in place rather than a second copy of the sentence appearing
 * underneath the first.
 *
 * @param props - The pending message to draw.
 */
export function RoomPendingRow({ post }: RoomPendingRowProps) {
  const send = usePostToRoom();
  const reply = useReplyInThread();
  const failed = post.status === 'failed';

  const retry = () => {
    const { clientId, roomId, threadRootId, text } = post;
    if (threadRootId === null) {
      send.mutate({ roomId, text, clientId });
      return;
    }
    reply.mutate({ roomId, rootEntryId: threadRootId, text, clientId });
  };

  return (
    <div
      data-testid="room-pending"
      data-status={post.status}
      className={cn(
        // The same left inset a message's words sit at — the gutter plus the
        // row's padding — so when the echo lands the sentence does not jump.
        'flex flex-col gap-1 py-1 pr-[var(--msg-padding-x)]',
        'pl-[calc(var(--msg-padding-x)+var(--msg-gutter-width)+var(--msg-gap))]'
      )}
    >
      <p
        className={cn(
          'text-sm break-words whitespace-pre-wrap',
          !failed && 'text-muted-foreground'
        )}
      >
        {post.text}
      </p>
      {failed ? (
        <div className="text-status-warning flex flex-wrap items-center gap-2 text-xs">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          {/* What went wrong is already in the toast, in the server's own
              sentence. This line says what is TRUE OF THIS MESSAGE — that it is
              still here and has not been sent — which the toast cannot, because
              by the time somebody reads this the toast is gone. */}
          <span>Not sent.</span>
          <button
            type="button"
            onClick={retry}
            className="focus-ring hover:text-foreground rounded underline underline-offset-2"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => usePendingPostStore.getState().discard(post.clientId)}
            className="focus-ring text-muted-foreground hover:text-foreground rounded underline underline-offset-2"
          >
            Discard
          </button>
        </div>
      ) : (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <Loader2 aria-hidden className="size-3 shrink-0 motion-safe:animate-spin" />
          Sending…
        </p>
      )}
    </div>
  );
}

/**
 * Everything this reader has sent into one conversation and not yet seen back.
 *
 * A plain list rather than part of the feed above it, deliberately: a feed's
 * articles carry "12 of 30", and a message that does not exist on the server yet
 * is not one of the thirty. It would also renumber the whole set every time
 * somebody typed.
 *
 * @param props.posts - The pending messages, oldest first.
 */
export function RoomPendingList({ posts }: { posts: readonly PendingPost[] }) {
  if (posts.length === 0) return null;
  return (
    <div className="flex flex-col">
      {posts.map((post) => (
        <RoomPendingRow key={post.clientId} post={post} />
      ))}
    </div>
  );
}
