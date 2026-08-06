/**
 * The compact card that opens over an identity — an avatar, a name, a
 * handle, and just enough context to place who or what this is.
 *
 * @module shared/ui/identity-hover-card
 */
import * as React from 'react';
import { Bot, Send } from 'lucide-react';
import { formatDuration } from '../lib/format-duration';
import { initialOf } from '../lib/initial-of';
import { cn } from '../lib/utils';
import { useLongPress } from '../model';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card';
import { IdentityAvatar } from './identity-avatar';
import type { IdentityOrigin } from './identity-origin';

/** How long the pointer has to sit on a trigger before the card opens. Radix's own default (700ms) reads as sluggish for something this small; this favours a quick glance. */
const OPEN_DELAY_MS = 300;

/**
 * Every open `IdentityHoverCard` instance's own close function, app-wide.
 *
 * Ordinarily this coordination is Radix's own job for free: each
 * `HoverCardContent` is a `DismissableLayer`, and ANY outside `pointerdown`
 * — including one that lands on a different card's trigger — reaches every
 * open layer's own document-level listener and closes it. Touch's gesture
 * priority (below) breaks exactly that: `stopPropagation` on a touch/pen
 * trigger press keeps the event from ever reaching `document`, so a second
 * card opened by touch can no longer rely on Radix noticing the first one is
 * still open. This closes that specific gap — opening a card closes every
 * other one this module knows about first — without reintroducing the
 * drawer race `stopPropagation` exists to prevent.
 */
const openCardCloseFns = new Set<() => void>();

/** What an agent identity adds to the card: how it runs, and whether it is working right now. */
export interface IdentityHoverCardAgentInfo {
  /** The runtime this agent runs on, e.g. `'Claude Code'`. Omitted chips are simply not drawn. */
  runtime?: string;
  /** The model this agent runs, e.g. `'Opus 4.8'`. */
  model?: string;
  /** Present while the agent has a turn in flight; absent otherwise. */
  working?: {
    /** The room it is working in, when that is worth naming. */
    room?: string;
    /** How long it has been working, in milliseconds. */
    forMs: number;
  };
}

/** The identity a hover card describes — everything it needs and nothing it has to fetch. */
export interface IdentityHoverCardDescriptor {
  /** What kind of identity this is. Drives the avatar's shape and fill, and which chips apply. */
  kind: 'human' | 'agent' | 'system';
  /** The name shown as the card's title. */
  displayName: string;
  /** The `@handle`, shown as a subtitle. Omitted entirely when there is none — never faked. */
  handle?: string;
  /** Identity colour. Agents fill their avatar with it; others tint. */
  color?: string;
  /** The identity's own emoji, when it has one. */
  emoji?: string;
  /** Where a human participant is posting from. Ignored for `agent`/`system`. */
  origin?: IdentityOrigin;
  /** Runtime, model, and live working state. Ignored for `human`/`system`. */
  agent?: IdentityHoverCardAgentInfo;
}

export interface IdentityHoverCardProps {
  /** The identity this card describes. */
  identity: IdentityHoverCardDescriptor;
  /**
   * The element that opens the card — on pointer hover, keyboard focus, or a
   * touch/pen long-press. Wrapped in `asChild`, so it keeps its own tag.
   */
  children: React.ReactNode;
  /** Extra classes for the popover content. */
  className?: string;
}

/** One pill of context inside the card — a fact about the identity, not a control. */
function InfoChip({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'bg-muted text-muted-foreground inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5 text-[11px]',
        className
      )}
    >
      {children}
    </span>
  );
}

/**
 * The compact identity card (design direction A): avatar and name up top,
 * `@handle` as its subtitle when there is one, a row of fact chips, and a
 * footer pinned under everything with a "View profile" affordance marked
 * **soon** — the click is deferred until there is a profile route to send it
 * to.
 *
 * **Opens three ways, one card.** A pointer hovering the trigger opens it
 * after {@link OPEN_DELAY_MS}, and keyboard focus opens it too, both straight
 * from Radix's own `HoverCard` wiring. Neither reaches a touch or pen input:
 * there is no hover to detect, and Radix's trigger deliberately excludes
 * `touch` pointers from that same open/close logic so a tap can never
 * masquerade as a hover. This adds the third path — holding a touch or pen
 * point on the trigger opens the SAME card through the SAME
 * `<HoverCardContent>`, via {@link useLongPress} (the room's own long-press
 * gesture, see `responsive-context-menu.tsx`) driving this component's own
 * controlled `open` state. One card, three ways in; never a second
 * implementation to keep in sync.
 *
 * A plain, quick tap does nothing on its own — deliberately. The mention
 * pill this wraps has no click action yet ("View profile" is still
 * **soon**), and a tap that opened the card would read as a click
 * affordance the pill does not actually have, one this would then have to
 * un-teach once a real tap-to-navigate lands. Long-press is also gated to
 * `pointerType === 'touch' || 'pen'` specifically, so it never doubles up
 * with a mouse holding the trigger down — hover already opens that case,
 * faster.
 *
 * **Gesture priority: the trigger wins over anything it sits inside.** A
 * mention pill in a room message lives inside `EntryActionMenu`, which arms
 * its OWN long-press on the whole row (touch screens open a message-actions
 * drawer the same way). Both gestures start from the identical `pointerdown`
 * — without help, holding a pill would race both timers and could open the
 * drawer AND this card at once. So a touch/pen `pointerdown` on the trigger
 * calls `stopPropagation`, before the row's own long-press ever arms; the
 * most specific target under the finger wins, and the row's drawer still
 * opens normally for a hold that starts anywhere else on the message. A
 * mouse pointerdown never stops propagating here — there is no competing
 * gesture on a mouse (the row's long-press only exists for touch), and this
 * must not touch desktop right-click/context behaviour.
 *
 * Presentational: it renders the descriptor it is handed and composes
 * {@link IdentityAvatar}. The caller resolves `identity` from whatever
 * source it has — the mock data in the dev playground today, a room roster
 * or `AuthorRef` lookup in the slice that wires this on for real.
 */
function IdentityHoverCard({ identity, children, className }: IdentityHoverCardProps) {
  const { kind, displayName, handle, color, emoji, origin, agent } = identity;
  // `IdentityAvatar` mixes this straight into `color-mix()`, and this app's
  // theme tokens store a bare `H S% L%` triple (e.g. `0 0% 9%`) rather than a
  // full `<color>` — an unwrapped `var(--muted-foreground)` here makes the
  // whole `color-mix()` invalid CSS, which silently drops the declaration
  // rather than just the fallback, leaving every colourless identity with no
  // disc background at all.
  const avatarColor = color ?? 'hsl(var(--muted-foreground))';
  const isExternal = typeof origin === 'object' && origin !== null;

  // Controlled rather than left to Radix's own internal state: hover and
  // focus still drive it exactly as before (their handlers call `onOpenChange`,
  // same as any uncontrolled `HoverCard`), but a touch long-press has no Radix
  // event to hook — it has to set `open` itself, on the very state Radix reads.
  const [open, setOpenState] = React.useState(false);
  // Stable across renders (empty deps) — this identity is what the effect
  // below uses as the `openCardCloseFns` Set key.
  const close = React.useCallback(() => setOpenState(false), []);
  const setOpen = React.useCallback((next: boolean) => {
    if (next) {
      // Close every other open card FIRST — including one closed this way,
      // which flips ITS OWN `open` to false and (via the effect below) drops
      // itself from the set on its own next render. Ordering matters: this
      // runs before `close` is added for the card opening now, so a card
      // never closes itself.
      for (const closeOther of openCardCloseFns) closeOther();
    }
    setOpenState(next);
  }, []);
  React.useEffect(() => {
    if (!open) return;
    openCardCloseFns.add(close);
    // Covers every way `open` goes back to `false` — this card's own
    // dismiss, another card's `setOpen(true)` calling `close` above, or
    // unmounting outright (e.g. scrolled out of a virtualized room feed).
    return () => {
      openCardCloseFns.delete(close);
    };
  }, [open, close]);
  // Which pointer is currently down on the trigger, read back when the long
  // press timer fires. A `PointerEvent` isn't available inside the timer
  // callback itself, so this is captured at `pointerdown` time instead.
  const isTouchLikePressRef = React.useRef(false);
  const longPress = useLongPress({
    onLongPress: () => {
      if (isTouchLikePressRef.current) setOpen(true);
    },
  });

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={OPEN_DELAY_MS}>
      <HoverCardTrigger
        asChild
        {...longPress}
        onPointerDown={(event: React.PointerEvent) => {
          const isTouchLike = event.pointerType === 'touch' || event.pointerType === 'pen';
          isTouchLikePressRef.current = isTouchLike;
          if (isTouchLike) {
            // The trigger is the most specific target under the finger —
            // stop here, before this bubbles to a message row's own
            // long-press (`EntryActionMenu`'s mobile drawer). Never done for
            // a mouse: nothing upstream arms a competing gesture from a
            // mouse pointerdown, and desktop right-click/context behaviour
            // must see every event exactly as it did before this existed.
            event.stopPropagation();
          }
          longPress.onPointerDown(event);
        }}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        data-slot="identity-hover-card"
        align="start"
        className={cn('flex w-64 flex-col gap-0 overflow-hidden p-0', className)}
      >
        <div className="flex items-center gap-3 p-3">
          <IdentityAvatar
            aria-hidden
            color={avatarColor}
            emoji={emoji}
            fallback={initialOf(displayName)}
            shape={kind === 'agent' ? 'square' : 'circle'}
            variant={kind === 'agent' ? 'fill' : 'tint'}
            badge={kind === 'agent' ? <Bot /> : isExternal ? <Send /> : undefined}
            size="md"
          />
          <div className="min-w-0">
            <p className="text-foreground truncate text-sm font-semibold">{displayName}</p>
            {handle && (
              <p className="text-muted-foreground truncate text-xs font-medium">@{handle}</p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 px-3 pb-3 empty:hidden">
          {kind === 'agent' && (agent?.runtime || agent?.model) && (
            <InfoChip>{[agent.runtime, agent.model].filter(Boolean).join(' · ')}</InfoChip>
          )}
          {kind === 'agent' && agent?.working && (
            <InfoChip className="bg-status-success-bg text-status-success-fg">
              <span
                aria-hidden
                className="bg-status-success relative inline-flex size-1.5 shrink-0 rounded-full"
              >
                <span className="bg-status-success absolute inset-0 animate-ping rounded-full opacity-75 motion-reduce:hidden" />
              </span>
              Working · {formatDuration(agent.working.forMs)}
            </InfoChip>
          )}
          {kind === 'human' && (
            <InfoChip>{isExternal ? origin.platform : 'On this machine'}</InfoChip>
          )}
        </div>

        <div className="border-border mt-auto flex items-center justify-between border-t px-3 py-2">
          <span className="text-brand text-xs font-medium">View profile</span>
          <span className="text-muted-foreground text-[10px] tracking-wide uppercase">soon</span>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export { IdentityHoverCard };
