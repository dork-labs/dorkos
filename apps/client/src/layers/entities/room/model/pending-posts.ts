/**
 * What you have sent and the room has not yet echoed back.
 *
 * A post is trigger-only: the 202 carries the entry's identity and the entry
 * itself arrives on the room's SSE stream, which is what every other reader —
 * and every agent the post triggers — sees. That is the right shape, and it left
 * one hole: between pressing Enter and the echo landing there was **nothing on
 * screen at all**. The composer takes the draft and clears it, and on a slow
 * link the words simply vanish for the round trip. Under a stalled stream they
 * vanished for good, silently, while the composer kept accepting more.
 *
 * So the words stay somewhere until the room can show them. This store is that
 * somewhere: a client-only row per message in flight, drawn at the tail of the
 * timeline it was sent to, retired the moment the real entry arrives.
 *
 * **It is deliberately not an optimistic entry.** An entry needs a `seq` only
 * the server can mint, and inserting a made-up one would fight the merge that
 * `useRoomStream` does by `seq` — the reason `usePostToRoom` never wrote to the
 * entry cache in the first place. A pending row is a different kind of thing,
 * rendered beside the log rather than in it, and it never enters the history.
 *
 * **Correlation is on the server's own `entryId`**, which the 202 returns. Not
 * on the text: a person sending "ok" twice has two rows and the first echo must
 * retire the first row, and only two ids can tell them apart.
 *
 * @module entities/room/model/pending-posts
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

/** Where a message that has been sent has got to. */
export type PendingPostStatus = 'sending' | 'failed';

/** One message in flight, or one that did not make it. */
export interface PendingPost {
  /**
   * This client's own id for the attempt, minted before the request.
   *
   * It exists because the server's id does not yet: the row has to be on screen
   * from the keystroke, which is before there is anything to call it. A retry
   * keeps the same one, so trying again moves the row that is already there
   * rather than stacking a second copy of the same sentence.
   */
  clientId: string;
  /** The room it was sent to. */
  roomId: string;
  /** The thread it was sent to, or `null` for the room's own flow. */
  threadRootId: string | null;
  /** What was typed. The words themselves, held nowhere else once sent. */
  text: string;
  /** Whether it is still in the air, or has come back refused. */
  status: PendingPostStatus;
  /**
   * The id the server minted, once the 202 has come back. `null` until then.
   *
   * The row does not retire on the 202 — that is the server saying it has the
   * message, not the room showing it. It retires when the entry itself arrives,
   * which is what everybody else in the room is looking at.
   */
  entryId: string | null;
  /** This client's clock at the first attempt, which is the order they draw in. */
  at: number;
}

/** Everything this client has said that the room has not said back. */
interface PendingPostState {
  /** Every attempt still on screen, oldest first. */
  posts: PendingPost[];
}

/** How a message in flight moves. */
interface PendingPostActions {
  /**
   * Put a message on screen, or move an existing one back into flight.
   *
   * Idempotent on `clientId`, which is what makes retry a move rather than a
   * copy: the failed row goes back to `sending` in place, keeping its position
   * at the tail and its original clock.
   *
   * @param post - Where it is going and what it says.
   */
  start: (post: {
    clientId: string;
    roomId: string;
    threadRootId: string | null;
    text: string;
    now?: number;
  }) => void;
  /**
   * Record the identity the server answered with.
   *
   * @param clientId - The attempt.
   * @param entryId - The id the entry will arrive under.
   */
  accepted: (clientId: string, entryId: string) => void;
  /**
   * Mark an attempt refused, so its row can offer to try again.
   *
   * @param clientId - The attempt.
   */
  failed: (clientId: string) => void;
  /**
   * Retire whichever attempt an arriving entry is the echo of.
   *
   * A no-op for an entry nobody here sent, which is nearly all of them.
   *
   * @param roomId - The room the entry landed in.
   * @param entryId - The entry's id.
   */
  settle: (roomId: string, entryId: string) => void;
  /**
   * Throw an attempt away at the reader's request.
   *
   * The only way words leave this store unsent, and it is deliberately a
   * decision somebody makes: a refusal that can never succeed — an archived
   * room — would otherwise leave a row nothing could clear.
   *
   * @param clientId - The attempt.
   */
  discard: (clientId: string) => void;
}

/** The pending-post store. Read it through {@link usePendingPosts}. */
export const usePendingPostStore = create<PendingPostState & PendingPostActions>()(
  devtools(
    (set) => ({
      posts: [],

      start: ({ clientId, roomId, threadRootId, text, now = Date.now() }) =>
        set(
          (held) => {
            const existing = held.posts.findIndex((post) => post.clientId === clientId);
            if (existing >= 0) {
              const posts = [...held.posts];
              posts[existing] = { ...posts[existing]!, status: 'sending', text };
              return { posts };
            }
            return {
              posts: [
                ...held.posts,
                { clientId, roomId, threadRootId, text, status: 'sending', entryId: null, at: now },
              ],
            };
          },
          false,
          'pendingPosts/start'
        ),

      accepted: (clientId, entryId) =>
        set(
          (held) => ({
            posts: held.posts.map((post) =>
              post.clientId === clientId ? { ...post, entryId } : post
            ),
          }),
          false,
          'pendingPosts/accepted'
        ),

      failed: (clientId) =>
        set(
          (held) => ({
            posts: held.posts.map((post) =>
              post.clientId === clientId ? { ...post, status: 'failed' as const } : post
            ),
          }),
          false,
          'pendingPosts/failed'
        ),

      settle: (roomId, entryId) =>
        set(
          (held) => {
            const kept = held.posts.filter(
              (post) => !(post.roomId === roomId && post.entryId === entryId)
            );
            return kept.length === held.posts.length ? held : { posts: kept };
          },
          false,
          'pendingPosts/settle'
        ),

      discard: (clientId) =>
        set(
          (held) => {
            const kept = held.posts.filter((post) => post.clientId !== clientId);
            return kept.length === held.posts.length ? held : { posts: kept };
          },
          false,
          'pendingPosts/discard'
        ),
    }),
    { name: 'PendingPostStore' }
  )
);

/** One shared empty answer, so the usual case never re-renders its reader. */
const NOTHING_PENDING: PendingPost[] = [];

/**
 * What this reader has sent into one place and not yet seen come back.
 *
 * Scoped to a destination rather than a room, because the room's composer and an
 * open thread's are two boxes on screen at once: a reply in flight belongs at
 * the tail of the thread it was typed in, not at the tail of the room.
 *
 * @param roomId - The room on screen, or `null` when none is.
 * @param threadRootId - The open thread, or `null` for the room's own flow.
 * @returns The attempts still on screen, oldest first.
 */
export function usePendingPosts(roomId: string | null, threadRootId: string | null): PendingPost[] {
  // The selector returns the store's OWN array and the narrowing happens in a
  // memo, which is not a style choice: a selector that filters mints a new array
  // on every call, and `useSyncExternalStore` compares snapshots by identity —
  // so it would re-render forever without the store having changed at all.
  const posts = usePendingPostStore((held) => held.posts);
  return useMemo(() => {
    if (roomId === null) return NOTHING_PENDING;
    const mine = posts.filter(
      (post) => post.roomId === roomId && post.threadRootId === threadRootId
    );
    return mine.length === 0 ? NOTHING_PENDING : mine;
  }, [posts, roomId, threadRootId]);
}

/** How many ids the fallback below has minted. */
let fallbackId = 0;

/**
 * A fresh id for one attempt.
 *
 * `crypto.randomUUID` where it exists, which is everywhere this app runs, with a
 * counter behind it so an environment without it still mints unique ids.
 *
 * @returns An id unique within this page's lifetime, which is all it has to be.
 */
export function newPendingId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  fallbackId += 1;
  return `pending-${fallbackId}`;
}
