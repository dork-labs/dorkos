import { useState } from 'react';
import { useLoadedRoomEntries } from '@/layers/entities/room';
import { useTasks, useTasksEnabled } from '@/layers/entities/tasks';
import { usePendingApprovals } from '@/layers/entities/attention';
import { useAttentionRows } from '@/layers/features/dashboard-attention';
import { QuietSuggestion } from '@/layers/features/feature-promos';
import { useNow } from '@/layers/shared/model';
import { useFrozenRoomCursor } from '../model/use-frozen-room-cursor';
import { forwardLookSentence, nextScheduledRun } from '../lib/forward-look';
import { QuietStateLine } from './QuietStateLine';

/**
 * Whether the line has been said, and whether it is allowed to be said again.
 *
 * `retired` is the whole of I2: once the line has come down it does not come
 * back on this mount. See {@link HomeQuietState} for why that is the calm
 * behaviour rather than the lazy one.
 */
type QuietPhase = 'waiting' | 'shown' | 'retired';

/** What {@link HomeQuietState} needs to decide the room is quiet. */
export interface HomeQuietStateProps {
  /** The room on screen — #team, on the home surface. */
  roomId: string;
  /**
   * Whether the presence strip is drawing anything.
   *
   * An agent working somewhere else keeps the pinned header on screen, and it
   * also makes "All quiet." untrue. The strip is the one part of the header this
   * component cannot read for itself, so the host passes its occupancy through —
   * the same boolean it hands the header.
   */
  presenceOccupied: boolean;
}

/**
 * The quiet state, wired: is there anything to say, and is it worth saying?
 *
 * Renders {@link QuietStateLine} on exactly one arrangement — a room with a
 * history behind it, nothing in it since the reader arrived, and nothing at all
 * in the pinned triage header above it. Every other case draws nothing:
 *
 * - **Nothing in the room yet** is day one, which the starter chips answer
 *   instead. "All quiet." over a conversation that has never happened would be
 *   describing silence as if it were calm.
 * - **Something said since you got here** is not a quiet morning, and this is
 *   the gate that makes the whole state honest. Without it "All quiet." sits
 *   over a conversation seconds old and stays there, which is worse than saying
 *   nothing: it is the room asserting something the feed underneath disproves.
 * - **Something waiting or something wrong** is the header's line, and it is
 *   already on screen saying it. Two statements about the same morning, three
 *   lines apart, is one too many.
 * - **Somebody working** is not quiet.
 *
 * **Recency is measured against a FROZEN cursor** ({@link useFrozenRoomCursor}),
 * and freezing is what makes it measurable at all. Opening the room marks it
 * read within a frame, so the live cursor always says "you have seen
 * everything"; the copy taken on arrival is the only thing that still knows
 * where the reader actually was. A `null` cursor — the room not loaded, or a
 * reader who is not a member — means "cannot say", and the line is withheld
 * rather than guessed at.
 *
 * **The line comes down once, and does not come back.** An agent taking a turn
 * flips the presence strip on and off, and a rule recomputed on every flip would
 * blink a bordered line in and out above a feed somebody is reading — a layout
 * jump for a sentence that is no longer true anyway. So the first time the room
 * stops being quiet the line retires for the rest of this mount, and the next
 * one is a fresh arrival on a fresh page. The fade in {@link QuietStateLine}
 * therefore plays exactly once, on the mount it belongs to.
 *
 * **The reads are the header's own reads.** `usePendingApprovals` and
 * `useAttentionRows` are the same cached queries the header holds, so asking
 * them here costs no request — and asking them, rather than being told, is what
 * keeps this component's rule in one place instead of split across a prop the
 * host would have to compute.
 *
 * **DorkBot's one suggestion rides inside this state** (spec D5.3), on a second
 * line under the first, which is how it inherits every gate above without
 * restating any of them: it is mounted only on the arrangement that draws the
 * line at all, so a frozen cursor that says "somebody has been talking", a
 * retired line, or a header with something waiting each silence it too.
 *
 * @param props - The room, and whether the presence strip is occupied.
 */
export function HomeQuietState({ roomId, presenceOccupied }: HomeQuietStateProps) {
  // A cache read, never a request: the room surface below is already fetching
  // this list, and the stream keeps it current.
  const entries = useLoadedRoomEntries(roomId);
  const frozenSeq = useFrozenRoomCursor(roomId);
  const { approvals, isError: approvalsUnavailable } = usePendingApprovals();
  const { total: headerRows } = useAttentionRows();

  const hasHistory = entries !== undefined && entries.length > 0;
  // `null` is "cannot say", and cannot say is not caught up. Compared on `seq`
  // rather than on a timestamp because `seq` is the room's own ordering and the
  // cursor is expressed in it; a clock comparison would need a threshold, and a
  // threshold is a number somebody made up.
  const caughtUp =
    frozenSeq !== null && entries !== undefined && entries.every((entry) => entry.seq <= frozenSeq);
  const headerSpeaks =
    approvals.length > 0 || approvalsUnavailable || headerRows > 0 || presenceOccupied;
  const quiet = hasHistory && caughtUp && !headerSpeaks;

  const [phase, setPhase] = useState<QuietPhase>('waiting');
  // Render-time state adjustment rather than an effect, so the line never
  // commits a frame it has already been retired out of.
  if (quiet && phase === 'waiting') setPhase('shown');
  else if (!quiet && phase === 'shown') setPhase('retired');

  const shows = quiet && phase !== 'retired';

  const tasksEnabled = useTasksEnabled();
  // Asked for only when there is a line to put the answer on. The Tasks list is
  // nobody else's business on this surface, and a cockpit that never goes quiet
  // never fetches it.
  const { data: tasks } = useTasks(tasksEnabled && shows);
  // Ticking, so "today at 6:00 PM" does not survive into tomorrow morning on a
  // cockpit somebody left open overnight — which is precisely the reader this
  // line is written for.
  const now = useNow();

  if (!shows) return null;

  return (
    <QuietStateLine
      forwardLook={forwardLookSentence(nextScheduledRun(tasks, now), now)}
      // Offered whether or not there is a run ahead. Anybody who schedules
      // anything always has a forward look, so making the suggestion wait for an
      // empty one would hide discovery from exactly the people running the most.
      // The pairing stays honest at the other end — a promo that offers what
      // this install already has does not qualify (see the registry's
      // `taskCount` condition), so "want your agents working while you sleep?"
      // cannot print under a run already scheduled for 6am.
      suggestion={<QuietSuggestion />}
    />
  );
}
