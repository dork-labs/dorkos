import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { File as FileIcon, Loader2, TriangleAlert } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import {
  findLandedEcho,
  PENDING_SLOW_MS,
  roomKeys,
  usePendingPostStore,
  usePostToRoom,
  useReplyInThread,
  type PendingPost,
  type RoomEntry,
} from '@/layers/entities/room';

interface RoomPendingRowProps {
  /** The message that has been sent and not yet come back. */
  post: PendingPost;
  /**
   * This reader's own author id in the room.
   *
   * Read only on a retry, to tell this reader's own words apart from an
   * identical sentence somebody else happened to send — see {@link findLandedEcho}.
   */
  viewerAuthorId: string;
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
 * **Three states.** In flight it is the same words at the same place, dimmed,
 * with a quiet spinner and nothing to press — there is nothing to decide, and a
 * control under every message anybody sends would be clutter over a state that
 * normally lasts a moment. Past {@link PENDING_SLOW_MS} it grows a Discard,
 * because "normally" has stopped applying and a row with no way out is a row
 * that can be stuck on screen for the rest of the session. Refused, it says so
 * and offers both. Nothing here can lose the words without somebody choosing to.
 *
 * The retry re-fires the same mutation with the same client id, so the row moves
 * back into flight in place rather than a second copy of the sentence appearing
 * underneath the first — and it looks first, because a request that timed out
 * after the server committed it is indistinguishable from one that never landed
 * (see {@link findLandedEcho}, and the copy below, which says so out loud).
 *
 * **Files ride along, and a retry re-sends them.** The row draws their NAMES as
 * inert chips — no link and no thumbnail, because the entry that would serve
 * them does not exist yet — and the row also carries the ids they were uploaded
 * under, so trying again sends the whole message rather than a stripped copy of
 * it. That works because nothing binds an attachment until an entry claims it,
 * and an unbound one stays readable by, and re-nameable by, the person who
 * uploaded it. So the second attempt costs no bytes and the row needs no
 * sentence apologising for what it dropped.
 *
 * @param props - The pending message to draw, and who is reading.
 */
export function RoomPendingRow({ post, viewerAuthorId }: RoomPendingRowProps) {
  const send = usePostToRoom();
  const reply = useReplyInThread();
  const queryClient = useQueryClient();
  const failed = post.status === 'failed';
  const slow = useIsSlow(post);

  const discard = () => usePendingPostStore.getState().discard(post.clientId);

  const retry = () => {
    const { clientId, roomId, threadRootId, text, attachmentIds, attachmentNames } = post;
    // Look before leaping. If these exact words from this reader are already in
    // the room, the send DID land and the confirmation is what went missing —
    // sending again would post it twice and spend a second agent turn on it.
    const held = queryClient.getQueryData<RoomEntry[]>(roomKeys.entries(roomId));
    if (findLandedEcho(held, post, viewerAuthorId) !== undefined) {
      discard();
      return;
    }
    // The files go back with the words. Nothing bound them — an attachment
    // belongs to whoever uploaded it and stays unbound until an entry claims it
    // — so the second attempt names the same ids and no bytes go up twice. A
    // retry that dropped them would send a message ABOUT files it no longer
    // carried, which is the DOR-480 failure wearing a different hat.
    if (threadRootId === null) {
      send.mutate({ roomId, text, clientId, attachmentIds, attachmentNames });
      return;
    }
    reply.mutate({
      roomId,
      rootEntryId: threadRootId,
      text,
      clientId,
      attachmentIds,
      attachmentNames,
    });
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
      {post.attachmentNames.length > 0 && (
        // Inert on purpose: there is no entry yet, so there is nothing to link
        // to and nothing to draw a thumbnail from. The chips say only what a
        // person needs to know here — the files are still in this message.
        <ul className="flex flex-wrap gap-1.5">
          {post.attachmentNames.map((name, index) => (
            <li
              // Keyed by position, not by name: attaching two files called
              // `log.txt` is ordinary, and duplicate keys make React drop one of
              // the chips. The list is inert and never reorders — it is one
              // frozen message — so the index is a stable identity here.
              key={`${index}-${name}`}
              className="bg-muted text-muted-foreground flex items-center gap-1 rounded-md px-2 py-1 text-xs"
            >
              <FileIcon aria-hidden className="size-3 shrink-0" />
              <span className="max-w-32 truncate">{name}</span>
            </li>
          ))}
        </ul>
      )}
      {failed ? (
        <div className="text-status-warning flex flex-wrap items-center gap-2 text-xs">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          {/* WHY it failed is already in the toast, in the server's own
              sentence. This line says what is true of THIS message — and the
              second half is not hedging: a request that times out after the
              server has committed it fails in exactly the same way as one that
              never arrived, so "not sent" alone would be a claim this client
              cannot make. Telling somebody to look before re-sending is the
              honest version until the send carries an idempotency key the
              server dedupes on (DOR-786). */}
          <span>Not sent — or it went through and the confirmation got lost.</span>
          <button
            type="button"
            onClick={retry}
            className="focus-ring hover:text-foreground rounded underline underline-offset-2"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={discard}
            className="focus-ring text-muted-foreground hover:text-foreground rounded underline underline-offset-2"
          >
            Discard
          </button>
        </div>
      ) : (
        <p className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          <Loader2 aria-hidden className="size-3 shrink-0 motion-safe:animate-spin" />
          <span>{slow ? 'Still sending…' : 'Sending…'}</span>
          {slow && (
            <button
              type="button"
              onClick={discard}
              className="focus-ring hover:text-foreground rounded underline underline-offset-2"
            >
              Discard
            </button>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * Whether this attempt has been in flight long enough to need a way out.
 *
 * A timer rather than a clock read during render: nothing else re-renders this
 * row while it waits, so asking "is it slow yet?" during a render that never
 * happens answers nothing. It is armed for the REMAINING time rather than a
 * fixed delay, so a row that mounts onto an attempt already older than the
 * threshold — reopening a room you left mid-send — is slow immediately.
 *
 * @param post - The attempt on screen.
 */
function useIsSlow(post: PendingPost): boolean {
  const [slow, setSlow] = useState(() => Date.now() - post.at >= PENDING_SLOW_MS);
  const { at, status } = post;

  useEffect(() => {
    if (status !== 'sending' || slow) return;
    // Always through a timer, never set straight from the effect body: an
    // attempt that is ALREADY past the threshold is handled by the initialiser
    // above, so the only thing a synchronous set here would add is a cascading
    // render for a state the row was mounted in.
    const timer = setTimeout(() => setSlow(true), Math.max(0, at + PENDING_SLOW_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [at, status, slow]);

  return slow;
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
 * @param props.viewerAuthorId - This reader's own author id in the room.
 */
export function RoomPendingList({
  posts,
  viewerAuthorId,
}: {
  posts: readonly PendingPost[];
  viewerAuthorId: string;
}) {
  if (posts.length === 0) return null;
  return (
    <div className="flex flex-col">
      {posts.map((post) => (
        <RoomPendingRow key={post.clientId} post={post} viewerAuthorId={viewerAuthorId} />
      ))}
    </div>
  );
}
