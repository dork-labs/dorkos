/**
 * The two things a room message renders so its actions can be REACHED: the
 * sticky rail the hover capsule rides, and the invisible button that hands a
 * touch screen reader into it.
 *
 * They ship together because they are one decision in two parts — the capsule
 * is revealed by hover and focus, and everything a reader who has neither needs
 * in order to use it is here. Splitting them would leave the rail's layout
 * notes in one file and the reason a fifth way in exists in another.
 *
 * @module widgets/room-view/ui/RoomEntryActions
 */
import type { RefObject } from 'react';
import {
  EntryActionBar,
  type EntryAction,
  type EntryActionBarHandle,
  type EntryActionBarReactions,
} from '@/layers/features/entry-actions';

interface RoomEntryActionsProps {
  /** What this message offers, in order. Empty means the row offers nothing. */
  actions: EntryAction[];
  /** The quick-reaction half of the capsule. */
  reactions: EntryActionBarReactions;
  /**
   * The toolbar's own handle, held by the ROW rather than by this component:
   * an arrow key pressed on the message steps into the same group this hands
   * focus to, so both need to be able to reach it.
   */
  barRef: RefObject<EntryActionBarHandle | null>;
  /** Hand focus back to the message — the way out, bound to Escape. */
  onExit: () => void;
  /** The toolbar's own look, supplied by the row so anchoring stays with layout. */
  className: string;
}

/**
 * A message's action surface, as the row renders it.
 *
 * Renders LAST inside the message body and, thanks to `order-first` on the
 * rail, draws first — see the rail's own note below for why that split matters.
 */
export function RoomEntryActions({
  actions,
  reactions,
  barRef,
  onExit,
  className,
}: RoomEntryActionsProps) {
  return (
    <>
      {actions.length > 0 && (
        /*
          The way into this message's actions for somebody using a screen
          reader on a touch screen — the one reader the capsule had no path
          for at all.

          The capsule is revealed by hover, which a finger never produces,
          and by focus, which is reached with an arrow key that VoiceOver's
          gestures do not send; and until it is revealed it is
          `pointer-events-none`, so even a reader who found a button by
          swiping could not activate it — the double-tap landed on the
          message underneath. The only remaining path was a 500ms long
          press, which VoiceOver does not produce either.

          So: a real button, in the accessibility tree, that hands focus to
          the capsule. Focus reveals it and turns its pointer events back
          on, which is what makes every button in it activatable from that
          point on.

          **`sr-only` and `tabIndex={-1}`, both load-bearing.** It costs no
          pixels, because sighted readers already have the hover capsule and
          the right-click menu. And it is NOT a tab stop: a room is one Tab
          per message (see `EntryActionBar`), and a second stop on every row
          would double what crossing a room costs to give a keyboard reader
          a second way to do what ArrowRight already does. VoiceOver reaches
          it by swipe, which does not care about the tab order.
        */
        <button
          type="button"
          tabIndex={-1}
          data-testid="entry-actions-reach"
          aria-label="Message actions"
          onClick={() => barRef.current?.focusFirst()}
          className="sr-only"
        />
      )}
      {/*
        The rail is the strip of gutter the capsule lives in — exactly one
        capsule tall, sitting directly ABOVE the message's first line, so the
        capsule straddles the message block's top edge and, for as long as
        that edge is on screen, covers no word of it (design record §1).
        `-mt` cancels its own height, so the band costs the row no vertical
        space and the message sits where it would have anyway: the capsule is
        drawn in the air between messages, not in a lane carved out for it.

        One rule, every grouping position. The band hangs off the message's
        own first line, and the row's top padding already moves with the
        grouping — so a group start (16px of padding) gets the even straddle
        the design draws, while a tight continuation (6px) reaches further up
        into the group's own 12px of air. That is the honest trade: a 30px
        capsule cannot fit in 12px, and of the two things it can overlap, the
        words of the message it ACTS ON are the ones it must never touch.

        It is also `sticky`, which is what keeps it reachable on a message
        longer than the window: it rides the message's top while that is on
        screen and clamps to the scroller's edge once the message extends
        above it. The clamp is unchanged by the band — `top-1` still pins the
        band's own top, so a clamped capsule sits exactly where it always
        did, and the handover is continuous because sticky never jumps.

        The clamp is also the one place the capsule DOES cover words: with a
        message's first line just under the scroller's edge, the pinned
        capsule sits over it. Nothing can be done about that without giving
        up either the clamp or the straddle, and the clamp is what makes a
        long message's actions reachable at all. It is a narrow band —
        roughly the capsule's own height of scroll — and off it entirely for
        the rest of the message.

        LAST in the DOM and `order-first` in the layout, deliberately. Read
        order is what a screen reader follows, and a toolbar announced ahead
        of the message would make every row open with "Reply in thread, Copy
        text" before saying who spoke or what they said — which is how session
        chat already has it, with its actions last. `order` moves the box
        without moving the reading order, and the sticky clamp is computed on
        the laid-out box, so it survives the move.

        `items-start` is load-bearing, not tidiness. A flex row's default
        `align-items: stretch` sizes a child to the line's cross size — which
        once squashed the pill to a 6px capsule with its own 24px buttons
        hanging out of it top and bottom, reading as a line ruled through the
        icons. Session chat never hit this: its `corner` anchor is
        `absolute`, so it is out of flow and no flex line ever sizes it.
        Pinned by "the toolbar encloses the buttons it is drawn around" in
        `room-entry-actions.spec.ts`.
      */}
      <div className="pointer-events-none sticky top-1 z-20 order-first -mt-(--msg-actions-height) flex h-(--msg-actions-height) items-start justify-end pr-2">
        <EntryActionBar
          ref={barRef}
          actions={actions}
          reactions={reactions}
          onExit={onExit}
          className={className}
        />
      </div>
    </>
  );
}
