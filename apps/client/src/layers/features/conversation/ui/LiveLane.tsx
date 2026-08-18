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
 * `scrollHeight` under `useStickToBottom`, which un-pins a reader who never
 * scrolled.
 *
 * Mounted once per conversation surface. A room's thread panel composes its own
 * `Conversation.Root` and therefore its own lane, scoped to the thread — which
 * is how "replying in a thread" stays one claim on one line.
 *
 * @module features/conversation/ui/LiveLane
 */
import { useState, type ReactNode } from 'react';
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
 * Which half of a room's presence this lane speaks for.
 *
 * With a thread open on a wide screen there are two lanes on the page — the
 * panel's and the room's — and one testid over both made "the room announced it"
 * unaskable: the query either found two nodes or silently answered with whichever
 * came first in the document. Named per scope, exactly as `RoomPresenceLine`
 * named its own announcer.
 */
export type LaneScope = 'room' | 'thread';

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
}: LiveLaneProps) {
  const [peekOpen, setPeekOpen] = useState(false);
  // Branch OFF, not shorter: the end states all read statically — the dot is
  // present, the words are present — so a reader who asked for less motion gets
  // no motion rather than a faster version of it.
  const reducedMotion = useReducedMotion() === true;
  const announcement = laneAnnouncement(state, unavailable);
  const empty = state.kind === 'empty';
  const offersPeek = state.kind === 'presence' && peek !== undefined;

  const content = (
    <LaneContent
      state={state}
      onRetry={onRetry}
      unavailable={unavailable}
      faces={faces}
      reducedMotion={reducedMotion}
    />
  );

  return (
    <div
      data-slot="live-lane"
      data-lane-scope={scope}
      data-lane-state={state.kind}
      // Mirrored onto the DOM because the test harness strips motion props: this
      // is how a unit test can see which branch was taken.
      data-lane-motion={reducedMotion ? 'off' : 'on'}
      // `h-6`, never `min-h`, and never inside the scroller. See the module note.
      className="flex h-6 shrink-0 items-center gap-2 overflow-hidden px-3 text-xs"
    >
      {/* The one live region. Mounted whether or not it has anything to say. */}
      <span
        data-testid={scope === 'thread' ? 'thread-presence-announcer' : 'room-presence-announcer'}
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
          {offersPeek ? (
            <ResponsivePopover
              open={peekOpen}
              onOpenChange={(open) => {
                setPeekOpen(open);
                onPeekOpenChange?.(open);
              }}
            >
              <ResponsivePopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={peekLabel}
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
                // The composer keeps the caret. Radix pulls focus into the panel
                // on open by default, which would take a reader out of a
                // half-typed message to look at a status readout.
                onOpenAutoFocus={(event) => event.preventDefault()}
                className="w-88 p-0"
              >
                <ResponsivePopoverTitle>{peekLabel}</ResponsivePopoverTitle>
                {peek}
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
