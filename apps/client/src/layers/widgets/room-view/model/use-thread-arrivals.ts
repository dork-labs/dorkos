/**
 * How each reply in the open thread got there, so it can be animated for it.
 *
 * @module widgets/room-view/model/use-thread-arrivals
 */
import { useEffect, useRef } from 'react';
import type { RoomEntry } from '@/layers/entities/room';

/** How one reply came to be on screen. */
export type ReplyArrival =
  /** It was already there when the panel opened. Drawn at rest. */
  | 'at-rest'
  /** It landed while the panel was open. The connector draws, it bounces in. */
  | 'dropped'
  /**
   * It landed while its author was on the presence line — so it IS the answer
   * the line was waiting for, and settles upward into the space that line is
   * leaving (design record §5.4).
   */
  | 'handed-off';

/**
 * How long after an agent was last seen working a reply from it still reads as
 * that agent's answer.
 *
 * A window rather than an exact match, and that is forced by how the two facts
 * reach React. The room's stream writes the presence clear (a zustand store)
 * and the reply itself (a TanStack Query cache) back to back from the stream
 * reader, outside React's event system — so they are two separate external-store
 * notifications, not one batched update. React commits the presence clear on its
 * own render FIRST, and by the render the reply appears on, "who is working" is
 * already empty. Comparing against the previous render's list therefore never
 * saw the hand-off in the running app, only in tests that batched both writes
 * into one act.
 *
 * Three seconds is far longer than that gap (it is one commit) and far shorter
 * than a turn, so it cannot mistake an unrelated later message for an answer.
 *
 * @internal Exported so its tests can pin the window from both sides.
 */
export const HANDOFF_WINDOW_MS = 3_000;

/**
 * Decide how each reply arrived, once per reply, and never change the answer.
 *
 * **Frozen at first sight**, which is the property that makes this correct
 * rather than merely working: an animation is a one-shot about a moment, and a
 * value that could flip on a later render would replay it — a reply re-bouncing
 * because an unrelated reaction arrived on a neighbour. Same reason
 * `EntryReactionRow` freezes its pill's pop at mount.
 *
 * `null` on the first pass and not an empty set, so the panel opening onto a
 * thread that already has ten replies draws ten replies, at rest — "mounted"
 * and "arrived" are different events and only the second one is motion.
 *
 * **The hand-off is the interesting judgement.** A reply whose author was on
 * the presence line a moment ago is that agent's answer: the line goes and the
 * words appear, and the design asks for those two to read as ONE gesture rather
 * than as a disappearance next to an appearance. A reply from anybody who was
 * not working is just a reply, and gets the ordinary drop. The distinction is
 * real and observable, which is why it is made here rather than animating
 * everything the same way and calling it close enough.
 *
 * Presence is read as "was this author working RECENTLY" rather than "is it
 * working now" — see {@link HANDOFF_WINDOW_MS}, which is the whole subtlety.
 *
 * @param replies - The open thread's replies, in log order.
 * @param workingAuthorIds - Who has a live claim in this thread right now.
 * @param now - This client's clock, injectable so a test can pin the hand-off
 *   window from BOTH sides. Without it the window only ever had a floor, and a
 *   `HANDOFF_WINDOW_MS` of ten minutes passed every test — a bound nothing
 *   checks is a bound that is not really there.
 * @param historyLoaded - Whether the room's history has actually arrived. Until
 *   it has, `replies` is empty because nothing has loaded rather than because
 *   the thread has none, and the two must not be confused: seeding on the empty
 *   one makes every already-existing reply look like an arrival and bounce in.
 *   That is what a `?thread=` deep link does on every single load.
 * @returns Reply id → how it arrived. Every reply has an entry.
 */
export function useThreadArrivals(
  replies: readonly RoomEntry[],
  workingAuthorIds: readonly string[],
  historyLoaded: boolean,
  now: () => number = Date.now
): ReadonlyMap<string, ReplyArrival> {
  /** Ids seen on a previous render. `null` until the first commit. */
  const seenRef = useRef<Set<string> | null>(null);
  /** Author id → this client's clock when it was last seen working here. */
  const workedAtRef = useRef(new Map<string, number>());
  /** The answer already given for each reply, so it is never given twice. */
  const arrivalsRef = useRef(new Map<string, ReplyArrival>());

  // Three refs read during render, deliberately, and for exactly the reason
  // `EntryReactionRow` sets out for its own: the question being asked is
  // literally "what was committed last time", which state cannot answer.
  // Setting state during render re-runs the component and hands back the NEW
  // value; setting it in an effect costs a whole extra render, and the reply
  // would mount one frame before the class that animates it — a bounce that
  // starts late is worse than none. Everything decided here is a one-shot
  // frozen at first sight, so a stale read cannot desynchronise anything a
  // reader can see.
  /* eslint-disable react-hooks/refs -- see above */
  const seen = seenRef.current;
  const workedAt = workedAtRef.current;
  const arrivals = arrivalsRef.current;
  const at = now();

  for (const reply of replies) {
    if (arrivals.has(reply.id)) continue;
    if (seen === null) {
      arrivals.set(reply.id, 'at-rest');
      continue;
    }
    const lastWorked = workedAt.get(reply.authorId);
    arrivals.set(
      reply.id,
      lastWorked !== undefined && at - lastWorked < HANDOFF_WINDOW_MS ? 'handed-off' : 'dropped'
    );
  }

  useEffect(() => {
    // Nothing is an arrival until there is a history for it to have arrived
    // INTO. Seeding on an unloaded room is what made a deep link replay itself.
    if (!historyLoaded) return;
    seenRef.current = new Set(replies.map((reply) => reply.id));
    const seenAt = now();
    for (const authorId of workingAuthorIds) workedAtRef.current.set(authorId, seenAt);
    for (const [authorId, when] of workedAtRef.current) {
      if (seenAt - when > HANDOFF_WINDOW_MS) workedAtRef.current.delete(authorId);
    }
    // A thread the reader has left and come back to should not replay its
    // history, but a map that only ever grows is a leak across every thread
    // opened in one session. Pruning to what is on screen does both.
    for (const id of arrivalsRef.current.keys()) {
      if (!seenRef.current.has(id)) arrivalsRef.current.delete(id);
    }
  });

  return arrivals;
  /* eslint-enable react-hooks/refs */
}
