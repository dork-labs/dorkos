/**
 * `Message.Root` — one message row, for every surface there is.
 *
 * It owns what only the whole row can: the single `messageItem()` call its
 * parts draw from, the right-click / long-press surface wrapped around it, and
 * how a touch press feels under the finger. Everything else is a part.
 *
 * **Every message row is an `article`.** That is the decision both parents
 * arrived at independently (`MessageItem`, `RoomEntryRow`), and it is why the
 * variant dial is called `role` while the DOM role is fixed: a row is an
 * article whoever wrote it, and `role="user" | "assistant"` is typography.
 *
 * What NAMES the article is the host's business — the author line already on
 * screen for a group start, a written label for a continuation — so the a11y
 * attributes arrive as ordinary props and are spread onto the element. The two
 * hosts each have their own rule (`entryRowArticleProps`, `feedArticleProps`)
 * and neither is this row's to invent.
 *
 * @module features/conversation/ui/message/MessageRoot
 */
import { useMemo, useState, type ComponentPropsWithoutRef, type Ref } from 'react';
import { Slot } from 'radix-ui';
import { motion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import type { LongPressState } from '@/layers/shared/model';
import {
  EntryActionMenu,
  type EntryAction,
  type EntryActionMenuReactions,
} from '@/layers/features/entry-actions';
import { useConversation } from '../../model/conversation-context';
import { messageItem } from './message-variants';
import { MessageStylesProvider, type MessagePosition } from './message-styles-context';

/**
 * Attributes a `div` has and `motion.div` reads differently — the drag and
 * animation callbacks, which motion re-types with its own event shapes. No host
 * passes one, and leaving them in the row's props would make every spread onto
 * the element a type error.
 */
type MotionOwnedProps = 'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart';

/** What one message row needs to draw itself. */
export interface MessageRootProps extends Omit<
  ComponentPropsWithoutRef<'div'>,
  'role' | MotionOwnedProps
> {
  /**
   * Whose voice this is — typography only, never layout. The DOM role is
   * `article` either way.
   */
  role?: 'user' | 'assistant';
  /** Where the row sits in its author group. Drives the vertical rhythm. */
  position?: MessagePosition;
  /** True for a row that has just arrived, which is the only one that animates in. */
  isNew?: boolean;
  /**
   * What this message offers, in order — the right-click menu and the touch
   * drawer. An empty set renders no menu at all rather than an empty one, so a
   * conversation whose rows offer nothing keeps the browser's own menu.
   */
  actions?: EntryAction[];
  /** The quick row the touch drawer opens with, when the conversation has reactions. */
  reactions?: EntryActionMenuReactions;
  /** Render as the child element instead of a `div`. */
  asChild?: boolean;
  ref?: Ref<HTMLDivElement>;
}

/** How a row arrives when it is new. Nothing else in the row moves on mount. */
const ARRIVAL = { type: 'spring', stiffness: 320, damping: 28 } as const;

/**
 * The row itself: the grid a message is laid out on, and the surface its actions
 * are reached from.
 *
 * The parts inside read one context for their slot classes, so the variant is
 * resolved here exactly once — a part that recomputed it could disagree with its
 * own row about which anchor it is on, and the disagreement would only ever show
 * up on screen.
 */
export function MessageRoot({
  role = 'assistant',
  position = 'only',
  isNew = false,
  actions,
  reactions,
  asChild = false,
  className,
  children,
  ref,
  ...rest
}: MessageRootProps) {
  const { density, anchor } = useConversation();
  // How the touch press is going, so the message can give under the finger
  // (room design record §5.6). Idle on a pointer device, which never reports one.
  const [press, setPress] = useState<LongPressState | null>(null);
  const styles = useMemo(
    () => ({ slots: messageItem({ role, position, density, anchor }), position }),
    [role, position, density, anchor]
  );
  const hasMenu = actions !== undefined && actions.length > 0;
  const Comp = asChild ? Slot.Root : motion.div;

  const row = (
    <Comp
      ref={ref}
      data-slot="message-root"
      role="article"
      // A row Page Down or Tab can land on has to SHOW that it was landed on.
      // Harmless on a row nothing can focus: a `:focus-visible` rule on an
      // element with no tab stop never matches.
      className={cn(
        styles.slots.root(),
        'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
        // The press acknowledgment. Touch-only in practice: nothing else
        // reports a press state. The squish is a transition and the spring-back
        // is an animation, which is what makes a CANCELLED press snap back with
        // neither — a reader who started scrolling gets no celebration for the
        // gesture they abandoned.
        'origin-center',
        // iOS answers a long press on text with its own selection callout, so a
        // press meant to open this message's drawer summoned Apple's
        // "Copy / Look Up" bubble on top of it — two menus for one gesture, and
        // the wrong one in front. Refused only where there IS a drawer to
        // protect: a row that offers no actions keeps the callout, which is the
        // only message menu it has.
        hasMenu && '[-webkit-touch-callout:none]',
        press === 'pressing' && 'motion-safe:animate-press-in',
        press === 'released' && 'motion-safe:animate-press-release',
        className
      )}
      {...(asChild
        ? {}
        : {
            initial: isNew ? { opacity: 0, y: 8 } : false,
            animate: { opacity: 1, y: 0 },
            transition: ARRIVAL,
          })}
      {...rest}
    >
      <MessageStylesProvider value={styles}>{children}</MessageStylesProvider>
    </Comp>
  );

  return (
    <EntryActionMenu actions={actions ?? []} reactions={reactions} onPressStateChange={setPress}>
      {row}
    </EntryActionMenu>
  );
}
