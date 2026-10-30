/**
 * What happens to your words when a room send fails, and how trying again works.
 *
 * Shared by the room's own composer and a thread's (`usePostToRoom`,
 * `useReplyInThread`) and by the two places a person can ask to try again: the
 * failed row and the failure toast. One definition, so the row and the toast
 * can never disagree about whether a retry re-posts or retires a message.
 *
 * @module entities/room/model/send/send-failure
 */
import type { QueryClient } from '@tanstack/react-query';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { roomKeys } from '../../api/query-keys';
import {
  findLandedEcho,
  usePendingPostStore,
  type PendingPost,
  type PendingPostFailure,
} from '../pending-posts';
import { threadDraftKey, useRoomDraftStore } from '../room-drafts';

/**
 * Whether a failed send can be called "Not sent".
 *
 * Only when the request failed before any response came back, which the
 * transport marks with `noResponse` (the server is down, or the network is).
 * Everything else stays `unknown`: a refusal, a timeout, or a body that broke
 * after the server answered may all have landed (DOR-786). One narrow case
 * remains, a server that saved the post and died before replying; the retry's
 * echo check (`findLandedEcho`) is what covers it.
 *
 * @param error - What the send rejected with.
 */
export function sendFailureOf(error: unknown): PendingPostFailure {
  return (error as { noResponse?: unknown } | null)?.noResponse === true ? 'not-sent' : 'unknown';
}

/** The draft key of the composer a message was typed in. */
function draftKeyOf(post: Pick<PendingPost, 'roomId' | 'threadRootId'>): string {
  return post.threadRootId === null ? post.roomId : threadDraftKey(post.roomId, post.threadRootId);
}

/**
 * Mark an attempt failed, and put its words back in the box they were typed in
 * when it is known never to have arrived.
 *
 * Only a `not-sent` failure goes back to the box. Sending from the box skips
 * the "did it land?" check a retry makes, so an attempt that may have landed
 * stays in its failed row alone, which asks the person to check first.
 *
 * The words go back only into an EMPTY box. A box with something in it holds a
 * sentence in progress, and a refusal must never overwrite one (DOR-783); the
 * failed row still holds the words in that case, so nothing is lost. The box
 * is the ROOM's draft, not the component's, so this works even when the
 * composer has gone because the person left the room.
 *
 * @param attempt - The attempt that failed.
 * @param error - What it failed with.
 */
export function failPendingPost(
  attempt: Pick<PendingPost, 'clientId' | 'roomId' | 'threadRootId' | 'text'>,
  error: unknown
): void {
  const failure = sendFailureOf(error);
  usePendingPostStore.getState().failed(attempt.clientId, failure);
  if (failure !== 'not-sent') return;
  const drafts = useRoomDraftStore.getState();
  const key = draftKeyOf(attempt);
  if ((drafts.drafts[key] ?? '').trim() === '') drafts.set(key, attempt.text);
}

/**
 * Retire the failed attempt that a new send from the composer is replacing.
 *
 * A failed message's words go back into the box, so sending them from there
 * IS the retry. Without this the failed row would stay under the new message,
 * still offering to post the same words a second time. Only the newest match
 * goes: two failed "ok" rows are two messages, and one send replaces one.
 *
 * @param destination - Where the new send is going.
 * @param text - What it says.
 */
export function retireFailedTwin(
  destination: Pick<PendingPost, 'roomId' | 'threadRootId'>,
  text: string
): void {
  const store = usePendingPostStore.getState();
  const twin = [...store.posts]
    .reverse()
    .find(
      (post) =>
        post.status === 'failed' &&
        post.roomId === destination.roomId &&
        post.threadRootId === destination.threadRootId &&
        post.text === text
    );
  if (twin !== undefined) store.discard(twin.clientId);
}

/**
 * Throw a failed attempt away, and its words with it if they are still sitting
 * untouched in the box — throwing a message away and then sending it with the
 * next Enter is not what Discard means.
 *
 * @param clientId - The attempt to throw away.
 */
export function discardPendingPost(clientId: string): void {
  const store = usePendingPostStore.getState();
  const post = store.posts.find((held) => held.clientId === clientId);
  store.discard(clientId);
  if (post === undefined) return;
  const drafts = useRoomDraftStore.getState();
  const key = draftKeyOf(post);
  if (drafts.drafts[key] === post.text) drafts.set(key, '');
}

/**
 * Try a failed attempt again, from the row or the toast.
 *
 * Looks first: when these exact words from this reader are already in the
 * room, the send DID land and only the confirmation went missing, so the row
 * retires instead of posting twice (see `findLandedEcho`). Then it takes the
 * words back OUT of the box if they are still sitting there untouched, so a
 * retried message is not also waiting to be sent again by hand.
 *
 * @param queryClient - The cache holding the room and its history.
 * @param clientId - The attempt to try again.
 * @param resend - Fires the attempt's own mutation with its own client id.
 * @param viewerAuthorId - This reader's author id, when the caller has it;
 *   read from the cached room otherwise.
 */
export function retryPendingPost(
  queryClient: QueryClient,
  clientId: string,
  resend: (post: PendingPost) => void,
  viewerAuthorId?: string
): void {
  const store = usePendingPostStore.getState();
  const post = store.posts.find((held) => held.clientId === clientId);
  // Gone already: discarded, or retried from the row before the toast.
  if (post === undefined || post.status !== 'failed') return;
  const viewer =
    viewerAuthorId ??
    queryClient.getQueryData<RoomWithRoster>(roomKeys.detail(post.roomId))?.viewerAuthorId;
  if (viewer !== undefined) {
    const held = queryClient.getQueryData<RoomEntry[]>(roomKeys.entries(post.roomId));
    if (findLandedEcho(held, post, viewer) !== undefined) {
      store.discard(clientId);
      return;
    }
  }
  const drafts = useRoomDraftStore.getState();
  const key = draftKeyOf(post);
  if (drafts.drafts[key] === post.text) drafts.set(key, '');
  resend(post);
}
