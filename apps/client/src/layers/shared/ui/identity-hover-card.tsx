/**
 * The compact card that opens over an identity — an avatar, a name, a
 * handle, and just enough context to place who or what this is.
 *
 * @module shared/ui/identity-hover-card
 */
import * as React from 'react';
import { formatDuration } from '@/layers/shared/lib/format-duration';
import { initialOf } from '@/layers/shared/lib/initial-of';
import { cn } from '@/layers/shared/lib/utils';
import { useLongPress } from '../model';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card';
import { IdentityAvatar } from './identity-avatar';
import type { IdentityOrigin } from '@/layers/shared/lib/identity-origin';

/** How long the pointer has to sit on a trigger before the card opens. Radix's own default (700ms) reads as sluggish for something this small; this favours a quick glance. */
const OPEN_DELAY_MS = 300;

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
  /**
   * The person this agent belongs to, when the roster knows one — owner
   * attribution (spec `identity-consistency` W1.6), resolved by the caller
   * from `TeamMember.ownerId` and rendered as a fourth chip. `handle: null`
   * falls back to the display name rather than rendering a bare `@`, the
   * same honesty rule `AuthorRef.handle` already carries everywhere else.
   */
  managedBy?: {
    displayName: string;
    handle: string | null;
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
  /**
   * The identity's photo, when it has one — the face the disc prefers over the
   * emoji. Used as the caller gives it; this card builds no URLs.
   */
  imageUrl?: string;
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
  /**
   * Open this identity's profile.
   *
   * A **prop, never an import**: the profile drawer is a feature and this card
   * is a `shared/ui` primitive, so the destination has to arrive from outside.
   * Supplied, the footer becomes a real control; omitted, it stays the inert
   * line marked **soon** — which is still the honest state on any surface that
   * has no id to open a profile with (a mention whose agent the fleet could not
   * name, for one).
   */
  onViewProfile?: () => void;
  /** Extra classes for the popover content. */
  className?: string;
}

/** One pill of context inside the card — a fact about the identity, not a control. */
function InfoChip({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'bg-muted text-muted-foreground text-2xs inline-flex max-w-full items-center gap-1 truncate rounded-full px-2 py-0.5',
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
 * footer pinned under everything carrying "View profile".
 *
 * **The footer is only as real as its destination.** Handed
 * {@link IdentityHoverCardProps.onViewProfile} it is a button that opens the
 * profile drawer; without one it stays the inert line marked **soon**, because
 * a surface that cannot name this identity to the roster has nothing to open.
 *
 * **The contract every consumer inherits: the footer is the POINTER path only.**
 * Radix's hover-card content is not a keyboard surface — focusing a trigger opens
 * the card, but everything inside it stays `tabindex="-1"`, so Tab leaves for the
 * next trigger rather than entering the card. A finger gets there only by
 * long-pressing (the third path below), never by tapping. So the keyboard door
 * has to be the trigger's OWN click — which is exactly what a mention pill and a
 * Team card make it.
 *
 * Which gives every surface that mounts this card one question to answer: **if
 * your trigger's click is not the profile, your surface has no keyboard profile
 * door — make sure another one exists.** Answering "another surface has one" is
 * a legitimate answer, and it is the one the presence strip gives (its press
 * follows the agent's work instead, and it says why in its own doc). Answering
 * nothing is not: it ships a profile a mouse can open and a keyboard cannot.
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
 * A plain, quick tap never opens this card, and now for a better reason than
 * when it was written: on a touch screen a tap on the trigger goes straight to
 * the profile, which is the full version of what this card summarises. The
 * card is the glance a pointer gets on the way; a finger skips it. Long-press
 * is gated to `pointerType === 'touch' || 'pen'` specifically, so it never
 * doubles up with a mouse holding the trigger down — hover already opens that
 * case, faster.
 *
 * **Gesture priority: the trigger wins over anything it sits inside, without
 * severing the event.** A mention pill in a room message lives inside
 * `EntryActionMenu`, which arms its OWN long-press on the whole row (touch
 * screens open a message-actions drawer the same way). Both gestures start
 * from the identical `pointerdown` — without help, holding a pill would race
 * both timers and could open the drawer AND this card at once. The fix is
 * NOT `stopPropagation`: that severs the native event before it ever reaches
 * `document`, which is where every Radix `DismissableLayer` — this card's
 * own included — listens for "something pressed outside me." A severed press
 * on one card's trigger can no longer close some OTHER open Radix overlay
 * (another identity card, an unrelated popover) — a real regression, caught
 * and reverted. Instead, the trigger marks itself `data-gesture-priority`,
 * and `ResponsiveContextMenu`'s `MobileTrigger` (`responsive-context-menu.tsx`)
 * yields to that marker in its OWN long-press's `pointerdown` — never arming
 * in the first place, rather than being interrupted mid-flight. The native
 * event keeps flowing to `document` exactly as it always did; only the ROW's
 * long-press stands down. Mouse pointerdowns are unaffected either way —
 * there is no competing row gesture for a mouse, and desktop right-click
 * behaviour never touches this at all.
 *
 * Presentational: it renders the descriptor it is handed and composes
 * {@link IdentityAvatar}. The caller resolves `identity` from whatever
 * source it has — the mock data in the dev playground today, a room roster
 * or `AuthorRef` lookup in the slice that wires this on for real.
 */
function IdentityHoverCard({
  identity,
  children,
  onViewProfile,
  className,
}: IdentityHoverCardProps) {
  const { kind, displayName, handle, color, emoji, imageUrl, origin, agent } = identity;
  // `IdentityAvatar` mixes this straight into `color-mix()`, and this app's
  // theme tokens store a bare `H S% L%` triple (e.g. `0 0% 9%`) rather than a
  // full `<color>` — an unwrapped `var(--muted-foreground)` here makes the
  // whole `color-mix()` invalid CSS, which silently drops the declaration
  // rather than just the fallback, leaving every colourless identity with no
  // disc background at all.
  const avatarColor = color ?? 'hsl(var(--muted-foreground))';
  const isExternal = typeof origin === 'object' && origin !== null;
  // **Asked once, answered once.** The disc used to test `working !== undefined`
  // and the chip below tested the same field for truth, so anything
  // present-but-empty — a resolver filling the field with `null` when there is
  // no turn — lit a pulsing "working right now" dot beside no chip at all. The
  // turn itself is the value both read, so there is no second predicate left to
  // disagree with the first.
  const working = kind === 'agent' && agent?.working != null ? agent.working : null;

  // Controlled rather than left to Radix's own internal state: hover and
  // focus still drive it exactly as before (their handlers call `onOpenChange`,
  // same as any uncontrolled `HoverCard`), but a touch long-press has no Radix
  // event to hook — it has to set `open` itself, on the very state Radix reads.
  // Nothing coordinates across instances here: the event keeps flowing to
  // `document` (see the doc above), so Radix's own `DismissableLayer` closes
  // this card the normal way the moment a press lands outside it — including
  // a press on a different card's trigger.
  const [open, setOpen] = React.useState(false);
  // Which pointer is currently down on the trigger, read back when the long
  // press timer fires. A `PointerEvent` isn't available inside the timer
  // callback itself, so this is captured at `pointerdown` time instead.
  const isTouchLikePressRef = React.useRef(false);
  // The trigger's own DOM node — a mention pill, an avatar — so the footer's
  // "View profile" can hand focus back to it before opening the profile
  // (DOR-1274 adversarial review).
  //
  // **Why the click handler can't just read `document.activeElement`.**
  // Clicking the footer button moves browser focus onto THAT button first —
  // native default behaviour, before React's `onClick` ever runs — so
  // whatever reads `document.activeElement` there sees the footer button, not
  // the trigger. The footer button is also portalled inside `HoverCardContent`
  // and unmounts the instant this card closes, which happens as part of the
  // very same interaction. A downstream capture (`useProfileDeepLink`'s
  // `open()`, called from `onViewProfile`) would grab a node that is already
  // gone by the time anything asks for it back — the exact DOR-1274 shape,
  // one layer closer to its actual cause than where the original fix looked.
  //
  // Refocusing the trigger HERE, before `onViewProfile` runs, means
  // `document.activeElement` is correct again by the time that downstream
  // capture reads it — no coordination between this component and the
  // profile-sheet plumbing required.
  const triggerRef = React.useRef<React.ElementRef<typeof HoverCardTrigger>>(null);
  const longPress = useLongPress({
    onLongPress: () => {
      if (isTouchLikePressRef.current) setOpen(true);
    },
  });

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={OPEN_DELAY_MS}>
      <HoverCardTrigger
        asChild
        ref={triggerRef}
        // Claims gesture priority (see the doc above) — an ancestor
        // `ResponsiveContextMenu` long-press yields to this marker rather
        // than racing it. An empty string: this is a presence flag, not a
        // value anything reads.
        data-gesture-priority=""
        {...longPress}
        onPointerDown={(event: React.PointerEvent) => {
          isTouchLikePressRef.current =
            event.pointerType === 'touch' || event.pointerType === 'pen';
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
            imageUrl={imageUrl}
            fallback={initialOf(displayName)}
            // Shape, fill and mark all come from the kind now, and the pulsing
            // dot from `status` — this card used to hand-roll all four, and
            // its own dot was a third copy of the same eight lines.
            kind={kind}
            origin={origin}
            status={working ? 'working' : 'idle'}
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
          {working && (
            // The chip says how long; the avatar's own dot says "right now".
            // The dot used to be drawn twice — once here and once on the disc —
            // which read as two separate signals for one fact.
            <InfoChip className="bg-status-success-bg text-status-success-fg">
              Working · {formatDuration(working.forMs)}
            </InfoChip>
          )}
          {kind === 'human' && (
            <InfoChip>{isExternal ? origin.platform : 'On this machine'}</InfoChip>
          )}
          {kind === 'agent' && agent?.managedBy && (
            <InfoChip>
              Managed by{' '}
              {agent.managedBy.handle ? `@${agent.managedBy.handle}` : agent.managedBy.displayName}
            </InfoChip>
          )}
        </div>

        {onViewProfile ? (
          <button
            type="button"
            data-slot="identity-hover-card-profile"
            onClick={() => {
              // Put focus back on the trigger BEFORE opening the profile, so
              // whatever captures `document.activeElement` downstream sees
              // the trigger rather than this button — see the doc on
              // `triggerRef` above.
              triggerRef.current?.focus();
              onViewProfile();
            }}
            className="border-border hover:bg-accent focus-visible:ring-ring text-brand mt-auto flex w-full items-center border-t px-3 py-2 text-left text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            View profile
          </button>
        ) : (
          <div className="border-border mt-auto flex items-center justify-between border-t px-3 py-2">
            {/* Muted, not brand orange. Orange means interaction or action
                (`contributing/design-system.md`), and this line is neither
                until something hands it a destination — the branch above is
                where it earns the colour back. Dressing an inert line as a
                control is the first thing an architect reading the source
                notices, and it was true here. */}
            <span className="text-muted-foreground text-xs font-medium">View profile</span>
            <span className="text-muted-foreground text-3xs tracking-wide uppercase">soon</span>
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

export { IdentityHoverCard };
