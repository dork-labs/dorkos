/**
 * `Message.Actions` — the one hover-action surface, held against the row the way
 * this conversation's `anchor` asks for.
 *
 * What it offers comes from the conversation's capabilities and from nothing
 * else: `reactions` adds the quick emoji and the picker, `runWith` adds "Run
 * this with…", and the commands the host built (reply, copy, mention, view
 * profile) fill the rest. There is no surface check anywhere in the chain.
 *
 * @module features/conversation/ui/message/MessageActions
 */
import type { RefObject } from 'react';
import { cva } from 'class-variance-authority';
import {
  EntryActionBar,
  type EntryAction,
  type EntryActionBarHandle,
  type EntryActionBarReactions,
  type EntryRunWith,
} from '@/layers/features/entry-actions';
import { useConversation } from '../../model/conversation-context';
import { useMessageStyles } from './message-styles-context';

/**
 * How the capsule is held against the row.
 *
 * `corner` contributes no box of its own — the capsule is absolutely positioned
 * against the row, so a wrapper with a box would only be something for a future
 * layout change to trip over.
 *
 * `rail` is the strip of gutter the capsule lives in — exactly one capsule tall,
 * sitting directly ABOVE the message's first line, so the capsule straddles the
 * message block's top edge and, for as long as that edge is on screen, covers no
 * word of it (room design record §1). `-mt` cancels its own height, so the band
 * costs the row no vertical space and the message sits where it would have
 * anyway: the capsule is drawn in the air between messages, not in a lane carved
 * out for it.
 *
 * One rule, every grouping position. The band hangs off the message's own first
 * line, and the row's top padding already moves with the grouping — so a group
 * start (16px of padding) gets the even straddle the design draws, while a tight
 * continuation (6px) reaches further up into the group's own 12px of air. That is
 * the honest trade: a 30px capsule cannot fit in 12px, and of the two things it
 * can overlap, the words of the message it ACTS ON are the ones it must never
 * touch.
 *
 * It is also `sticky`, which is what keeps it reachable on a message longer than
 * the window: it rides the message's top while that is on screen and clamps to
 * the scroller's edge once the message extends above it. The clamp is the one
 * place the capsule DOES cover words — a narrow band, roughly the capsule's own
 * height of scroll — and nothing can be done about that without giving up either
 * the clamp or the straddle.
 *
 * `items-start` is load-bearing, not tidiness. A flex row's default
 * `align-items: stretch` sizes a child to the line's cross size — which once
 * squashed the pill to a 6px capsule with its own 24px buttons hanging out of it
 * top and bottom, reading as a line ruled through the icons. The `corner` anchor
 * never hit this: it is `absolute`, so no flex line ever sizes it. Pinned by "the
 * toolbar encloses the buttons it is drawn around" in `room-entry-actions.spec.ts`.
 */
const actionsRail = cva('', {
  variants: {
    anchor: {
      corner: 'contents',
      rail: 'pointer-events-none sticky top-1 z-20 order-first -mt-(--msg-actions-height) flex h-(--msg-actions-height) items-start justify-end pr-2',
    },
  },
});

/** What the action surface needs. */
export interface MessageActionsProps {
  /** The commands this message offers, in order. Empty is normal, not an error. */
  actions?: EntryAction[];
  /** The quick-reaction half of the capsule. Ignored unless the conversation has reactions. */
  reactions?: EntryActionBarReactions;
  /** What "run this again, elsewhere" would re-run. Ignored unless the conversation has run-with. */
  runWith?: EntryRunWith;
  /**
   * The toolbar's own handle, held by the ROW rather than by this part: an arrow
   * key pressed on the message steps into the same group the reach button hands
   * focus to, so both need to be able to reach it.
   */
  barRef?: RefObject<EntryActionBarHandle | null>;
  /** Hand focus back to the message — the way out, bound to Escape. */
  onExit: () => void;
}

/**
 * A message's action surface, as the row renders it.
 *
 * Renders LAST inside the message body and, under the `rail` anchor, draws
 * first: read order is what a screen reader follows, and a toolbar announced
 * ahead of the message would make every row open with "Reply in thread, Copy
 * text" before saying who spoke or what they said. `order` moves the box without
 * moving the reading order, and the sticky clamp is computed on the laid-out
 * box, so it survives the move.
 */
export function MessageActions({
  actions = [],
  reactions,
  runWith,
  barRef,
  onExit,
}: MessageActionsProps) {
  const { capabilities, anchor } = useConversation();
  const { slots } = useMessageStyles();

  return (
    <>
      {actions.length > 0 && (
        /*
          The way into this message's actions for somebody using a screen reader
          on a touch screen — the one reader the capsule had no path for at all.

          The capsule is revealed by hover, which a finger never produces, and by
          focus, which is reached with an arrow key that VoiceOver's gestures do
          not send; and until it is revealed it is `pointer-events-none`, so even
          a reader who found a button by swiping could not activate it — the
          double-tap landed on the message underneath. The only remaining path
          was a 500ms long press, which VoiceOver does not produce either.

          So: a real button, in the accessibility tree, that hands focus to the
          capsule. Focus reveals it and turns its pointer events back on, which
          is what makes every button in it activatable from that point on.

          **`sr-only` and `tabIndex={-1}`, both load-bearing.** It costs no
          pixels, because sighted readers already have the hover capsule and the
          right-click menu. And it is NOT a tab stop: a conversation is one Tab
          per message (see `EntryActionBar`), and a second stop on every row
          would double what crossing it costs to give a keyboard reader a second
          way to do what ArrowRight already does. VoiceOver reaches it by swipe,
          which does not care about the tab order.

          Offered where there are COMMANDS to reach: run-with keeps a tab stop of
          its own, so a capsule holding only that one is already reachable by
          every reader.
        */
        <button
          type="button"
          tabIndex={-1}
          data-testid="entry-actions-reach"
          aria-label="Message actions"
          onClick={() => barRef?.current?.focusFirst()}
          className="sr-only"
        />
      )}
      <div data-slot="message-actions" className={actionsRail({ anchor })}>
        <EntryActionBar
          ref={barRef}
          actions={actions}
          reactions={capabilities.reactions ? reactions : undefined}
          runWith={capabilities.runWith ? runWith : undefined}
          onExit={onExit}
          className={slots.actions()}
        />
      </div>
    </>
  );
}
