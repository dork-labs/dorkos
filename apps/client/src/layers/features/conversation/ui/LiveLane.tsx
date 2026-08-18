/**
 * `Conversation.LiveLane` — one reserved line above the composer that says what
 * is happening here.
 *
 * **The height is the feature.** A fixed 24 px, never `min-h`, mounted whether
 * or not there is anything to say, so a room that goes from quiet to busy moves
 * nothing on screen. The line it replaces on both surfaces came and went, which
 * meant an agent picking something up pushed the last message you were reading.
 *
 * **A flex sibling of the scroller, never inside it.** `RoomSurface.tsx`
 * documents why in full: a height change inside the scrolling element moves
 * `scrollHeight` under `useTimelineScroll`, which un-pins a reader who never
 * scrolled.
 *
 * Mounted once per conversation surface. A room's thread panel composes its own
 * `Conversation.Root` and therefore its own lane, scoped to the thread — which
 * is how "replying in a thread" stays one claim on one line.
 *
 * @module features/conversation/ui/LiveLane
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { LaneState } from '../model/lane-state';
import { LaneContent, laneAnnouncement, laneMotionKey } from './LaneContent';

/**
 * How long the lane takes to change what it says.
 *
 * The bottom of the 150–200 ms crossfade band the design record sets. Nothing
 * else in the lane moves except the working dot's own breathing.
 */
const LANE_CROSSFADE_S = 0.16;

/**
 * Which conversation this lane speaks for.
 *
 * With a thread open on a wide screen there are two lanes on the page — the
 * panel's and the room's — and one testid over both made "the room announced it"
 * unaskable: the query either found two nodes or silently answered with whichever
 * came first in the document. Named per scope, exactly as `RoomPresenceLine`
 * named its own announcer.
 *
 * `session` is here for the same reason and answers a different complaint: a
 * session's lane was drawing the ROOM's announcer name on `/session`, where
 * there is no room and never any presence. A name that is wrong is worse than a
 * name that is generic.
 */
export type LaneScope = 'room' | 'thread' | 'session';

/** What the live region is called on each surface. */
const ANNOUNCER_TESTID: Record<LaneScope, string> = {
  room: 'room-presence-announcer',
  thread: 'thread-presence-announcer',
  session: 'session-lane-announcer',
};

/** What the live lane needs to draw itself. */
export interface LiveLaneProps {
  /** What the lane is saying, from `deriveLaneState`. */
  state: LaneState;
  /** Which half of a room's presence this lane speaks for. Defaults to the room's. */
  scope?: LaneScope;
  /** Ask the stream to try now. Drawn by the stalled rung when the host offers one. */
  onRetry?: () => void;
  /** True when the room itself is gone rather than merely unreachable. */
  unavailable?: boolean;
  /** Faces to stack in front of the presence sentence, already resolved and capped by the host. */
  faces?: ReactNode;
  /**
   * What opens when the presence line is clicked — `Conversation.LivePeek`,
   * built by the host from data only it holds.
   *
   * Absent means the presence line is a plain line: no trigger, no tab stop, no
   * popover. That is the right answer for a surface with nothing more to show.
   */
  peek?: ReactNode;
  /**
   * Told when the peek opens and closes.
   *
   * The host's cue to fetch what the peek needs — the room→session bindings are
   * only ever wanted by this affordance, so they are not fetched on room mount.
   */
  onPeekOpenChange?: (open: boolean) => void;
  /** What the peek's trigger is called, for a reader who cannot see the line. */
  peekLabel?: string;
  /**
   * The Ask card this lane's amber rung grows into, supplied by the host.
   *
   * A node rather than a component, for the reason the peek is one: the card
   * needs the roster and the router, and neither belongs in a surface-neutral
   * slice. Absent leaves the amber line a readout — true, and not answerable
   * here.
   */
  askCard?: ReactNode;
  /**
   * Force the reduced-motion branch, for the Dev Playground alone.
   *
   * **Playground-only, and the product never passes it.** `useReducedMotion()`
   * reads the media query rather than any React context, so a bench has no way
   * to show the branch a reader with "Reduce motion" on actually gets — and a
   * bench that cannot show what it claims is worse than none. Omitted, the lane
   * asks the reader's own system setting, which is the only thing that decides
   * it in the app.
   */
  reducedMotionOverride?: boolean;
}

/**
 * The lane.
 *
 * **One live region, and it is always mounted.** A region that arrives with its
 * text already in it is the classic case assistive technology does not announce
 * — the region has to be there first, so the sentence lands as a CHANGE to
 * something already being watched. Same shape as `ToolApproval`'s announcer, and
 * the same shape `RoomPresenceLine` carried before it. It is `sr-only`, so it
 * reserves no space of its own inside the 24 px.
 *
 * **One tab stop, and only when there is something to press.** The presence line
 * becomes a button when a peek is offered; the stalled line carries its
 * Reconnect; every other rung is a readout and takes no focus at all. A quiet
 * lane is `aria-hidden` and holds nothing focusable, so Tab crosses it as if it
 * were not there — which, to a reader, it is not.
 *
 * @param props - The state, the scope, and the host's affordances.
 */
export function LiveLane({
  state,
  scope = 'room',
  onRetry,
  unavailable = false,
  faces,
  peek,
  onPeekOpenChange,
  peekLabel = 'Show who is working',
  askCard,
  reducedMotionOverride,
}: LiveLaneProps) {
  const [peekOpen, setPeekOpen] = useState(false);
  const laneRef = useRef<HTMLDivElement>(null);
  // Branch OFF, not shorter: the end states all read statically — the dot is
  // present, the words are present — so a reader who asked for less motion gets
  // no motion rather than a faster version of it.
  const systemReducedMotion = useReducedMotion() === true;
  const reducedMotion = reducedMotionOverride ?? systemReducedMotion;
  const announcement = laneAnnouncement(state, unavailable);
  const empty = state.kind === 'empty';
  // Two rungs open something over the lane, and they share one popover: the
  // presence line opens the peek, and the amber Ask grows into its card. Sharing
  // it is what keeps the 24 px promise — the card is drawn OVER the composer,
  // never inside the lane, so nothing below it moves when it opens.
  const offersPeek = state.kind === 'presence' && peek !== undefined;
  const offersAsk = state.kind === 'ask' && askCard !== undefined;
  const offersPopover = offersPeek || offersAsk;
  const popoverBody = offersAsk ? askCard : peek;
  const popoverLabel = offersAsk ? 'Answer this' : peekLabel;

  // **Close the peek when its trigger stops existing.** The rung leaves
  // `presence` the moment the work ends, which unmounts the popover — and Radix
  // fires no `onOpenChange` for an unmount, so `peekOpen` stayed `true` and the
  // NEXT claim mounted the peek already open, over the composer, unasked.
  //
  // Adjusted during render rather than in an effect, which is the same shape
  // `RoomPresenceLine` used for the same shape of problem: React re-runs this
  // component before committing anything, so the correction costs a render pass
  // rather than a frame of the wrong thing — and a `setState` inside an effect
  // is a cascading render the lint rule is right to object to.
  if (peekOpen && !offersPopover) setPeekOpen(false);
  const peekIsOpen = peekOpen && offersPopover;

  // Telling the HOST is a side effect and belongs in one. It is what stops
  // `useRoomSessions` staying enabled for the life of the view — the second
  // damage the silent unmount did.
  //
  // Focus is handed back deliberately rather than left where Radix drops it: the
  // trigger the reader was standing on has just been removed, and the browser's
  // answer to that is `document.body`, which restarts Tab at the top of the
  // page. The lane's own root is always mounted and sits immediately before the
  // composer, so it is one Tab from where the reader was going anyway — and a
  // reader who had already moved on is left exactly where they are.
  const reportedOpenRef = useRef(false);
  useEffect(() => {
    if (reportedOpenRef.current === peekIsOpen) return;
    const wasInside =
      !peekIsOpen &&
      (laneRef.current?.contains(document.activeElement) === true ||
        document.activeElement === document.body);
    reportedOpenRef.current = peekIsOpen;
    onPeekOpenChange?.(peekIsOpen);
    if (wasInside) laneRef.current?.focus();
  }, [peekIsOpen, onPeekOpenChange]);

  const content = (
    <LaneContent
      state={state}
      onRetry={onRetry}
      unavailable={unavailable}
      faces={faces}
      reducedMotion={reducedMotion}
      scope={scope}
    />
  );

  return (
    <div
      ref={laneRef}
      data-slot="live-lane"
      data-lane-scope={scope}
      // Focusable only programmatically: it is never a tab stop of its own, and
      // exists as a landing place for the caret when the peek closes out from
      // under a reader who was standing in it.
      tabIndex={-1}
      data-lane-state={state.kind}
      // Mirrored onto the DOM because the test harness strips motion props: this
      // is how a unit test can see which branch was taken.
      data-lane-motion={reducedMotion ? 'off' : 'on'}
      // `h-6`, never `min-h`, and never inside the scroller. See the module note.
      className="flex h-6 shrink-0 items-center gap-2 overflow-hidden px-3 text-xs"
    >
      {/* The one live region. Mounted whether or not it has anything to say. */}
      <span
        data-testid={ANNOUNCER_TESTID[scope]}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </span>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={laneMotionKey(state)}
          initial={reducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reducedMotion ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: reducedMotion ? 0 : LANE_CROSSFADE_S }}
          // The quiet lane is hidden from assistive technology and holds nothing
          // to press. The announcer above it stays live either way, which is why
          // this sits on the content rather than on the lane.
          aria-hidden={empty ? 'true' : undefined}
          className="flex min-w-0 flex-1 items-center"
        >
          {offersPopover ? (
            <ResponsivePopover open={peekIsOpen} onOpenChange={setPeekOpen}>
              <ResponsivePopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={popoverLabel}
                  className={cn(
                    'focus-ring flex min-w-0 items-center rounded text-left',
                    // The hover step and its focus-visible twin, per the design
                    // system's parity rule — a mouse and a keyboard get the same
                    // affordance.
                    'hover:bg-accent/40 focus-visible:bg-accent/40'
                  )}
                >
                  {content}
                </button>
              </ResponsivePopoverTrigger>
              <ResponsivePopoverContent
                side="top"
                align="start"
                // The composer keeps the caret for the PEEK, which is a
                // readout. The Ask card is the opposite — a person opened it to
                // answer something — so it takes focus, and its own `A`/`D` keys
                // only work once it has.
                onOpenAutoFocus={offersAsk ? undefined : (event) => event.preventDefault()}
                className="w-88 p-0"
              >
                <ResponsivePopoverTitle>{popoverLabel}</ResponsivePopoverTitle>
                {popoverBody}
              </ResponsivePopoverContent>
            </ResponsivePopover>
          ) : (
            content
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
