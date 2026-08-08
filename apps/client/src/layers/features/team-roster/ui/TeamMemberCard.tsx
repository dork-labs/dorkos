import type { CSSProperties, Ref } from 'react';
import { motion, type MotionProps } from 'motion/react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { Badge, IdentityAvatar, IDENTITY_BADGE_WAKE } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import { platformLabel } from '@/layers/entities/room';
import { teamMemberFace, teamMemberLabel } from '@/layers/entities/team';

/**
 * The second line under a name: what is true of this identity and nothing else.
 *
 * An agent runs on something; a person is somewhere. Neither line is invented —
 * a person with no declared role says where they are rather than guessing at a
 * title, which is the honest version of the same sentence.
 *
 * Both names go through the same resolvers the rest of the cockpit uses —
 * `getRuntimeDescriptor` for a runtime, `platformLabel` for a platform — so a
 * person bridged in reads "On Telegram" here and everywhere else, rather than
 * the wire token this surface happens to hold.
 */
function secondaryLine(member: TeamMember): string {
  if (member.agent) {
    const runtime = getRuntimeDescriptor(member.agent.runtime).label;
    return member.agent.model ? `${runtime} · ${member.agent.model}` : runtime;
  }
  if (member.person?.role) return member.person.role;
  if (member.origin === 'local') return 'On this machine';
  return `On ${platformLabel(member.origin.platform)}`;
}

/**
 * The motion this card carries when the grid has armed layout animation.
 *
 * `layout="position"` and not plain `layout`: every card in the grid is the
 * same size, so interpolating size as well as position would spend measurement
 * on a dimension that never changes. `StatusLine.tsx` already uses this exact
 * prop.
 *
 * **And `layout`, deliberately not `layoutId`.** The design spec prescribed
 * `layoutId={member.id}` to carry a card between the flat grid and its owner's
 * cluster. Measured in a browser, that prescription does not work: an element
 * with a `layoutId` is handed to motion's shared-layout system, which animates
 * it only when it is handed off between two trees — so a card whose *siblings*
 * moved stopped animating entirely, and filtering the roster made every
 * survivor teleport. Worse, an exiting `layoutId` element inside
 * `AnimatePresence` waits for a handoff that never arrives and is never
 * unmounted: leavers stayed in the DOM as invisible absolutely-positioned
 * ghosts, forever. Both were invisible to jsdom and to typecheck.
 *
 * `TeamRosterGrid` solves the travel structurally instead, by keeping one flat
 * child list across both arrangements, so a card keeps its React identity and
 * plain `layout` animates it. See the note there.
 *
 * The spring is 280/32, the repo's existing layout spring — so a card sliding
 * matches a nav pill sliding rather than introducing a second physics.
 */
const LAYOUT_MOTION: MotionProps = {
  layout: 'position',
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1 },
  // Faster leaving than arriving: something on its way out should not hold the
  // eye as long as something arriving.
  exit: { opacity: 0, scale: 0.97, transition: { duration: 0.15 } },
  transition: {
    layout: { type: 'spring', stiffness: 280, damping: 32 },
    duration: 0.2,
    ease: [0, 0, 0.2, 1],
  },
};

export interface TeamMemberCardProps {
  /** The identity this card draws. */
  member: TeamMember;
  /**
   * The person this identity belongs to, already resolved from the roster.
   *
   * Resolved by the caller rather than looked up here: a card that could reach
   * the whole roster is a card that starts making decisions about it, and the
   * attribution is the only thing on this surface that needs a second row.
   */
  owner?: TeamMember;
  /** Narrow the roster to one person — what the attribution and a person's own card do. */
  onSelectOwner?: (ownerId: string) => void;
  /**
   * How many agents the owner has, for the attribution's hover echo.
   *
   * Resolved by the caller for the same reason `owner` is: a card that could
   * reach the whole roster is a card that starts making decisions about it.
   * Omitted, the attribution simply does not echo — which is what a card
   * rendered outside a roster should do.
   */
  ownedAgentCount?: number;
  /**
   * Whether this card travels to its new position when the grid re-orders.
   *
   * Off by default, because a card rendered on its own has nowhere to travel
   * from. `TeamRosterGrid` decides for the whole grid at once
   * (`shouldAnimateRoster`) and passes the same boolean to every card.
   */
  layoutAnimated?: boolean;
  /**
   * Forwarded to the card's root element.
   *
   * **Load-bearing, not a convenience.** `AnimatePresence mode="popLayout"`
   * takes an exiting card out of the layout flow by writing `position:
   * absolute` onto its DOM node, and it can only reach that node through a ref
   * this component passes on. Without it `popLayout` silently does nothing:
   * measured in a browser, an exiting card kept `position: relative`, held its
   * grid slot, and every survivor sat still for the length of the exit before
   * closing the gap. Nothing reports that — the animation simply looks laggy.
   */
  ref?: Ref<HTMLElement>;
  /**
   * Open this identity's profile. Wired, the whole card becomes the control
   * that does it; unwired, the card is the plain read-only tile it was.
   */
  onOpenProfile?: (memberId: string) => void;
  className?: string;
}

/**
 * One identity on the Team page: who it is, what it is, and who it belongs to.
 *
 * The disc is drawn from `kind` and nothing else — square and filled with a Bot
 * mark for an agent, a circle for a person, a platform mark for someone bridged
 * in from elsewhere — so this card cannot draw an agent as a person by
 * forgetting a prop. The face itself comes from the one shared resolver, which
 * falls back to a letter rather than inventing an emoji: "we don't know this
 * one's face" is a true thing to draw, and a confident-looking wrong face is not.
 *
 * **No liveness dot.** The roster carries `recentlyActive`, which means the mesh
 * heard from this agent within the hour — not that it is doing something right
 * now. The pulsing dot on the disc says "right now", so wiring the two together
 * would put a live signal on an agent that finished forty minutes ago. It is
 * drawn as words instead, where an hour-old fact reads as an hour-old fact.
 *
 * **And no health, deliberately.** `agent.healthStatus` is on the payload and is
 * drawn nowhere here: the difference between `stale` and `inactive` is a fact
 * about the mesh's last contact, which is what the topology view is for. A
 * roster answers "who is here", so it shows presence and stops — four states
 * per card would be a diagnostic panel wearing a roster's clothes.
 *
 * Nothing here branches on there being one person, and `isSelf` only decides
 * whether a chip is drawn (spec §W2.6) — a second person and a remote member
 * both arrive as more rows, not as another code path.
 *
 * **The whole card opens the profile, and the button is the name.** The name
 * carries an overlay pinned to the card's own box, so a press anywhere on the
 * tile lands on a real `<button>` a keyboard can reach and a screen reader can
 * announce — rather than a click handler on the `<article>`, which is neither.
 * It also settles the double-fire for free: the attribution control sits ABOVE
 * that overlay in the paint order, so pressing it never reaches the profile at
 * all and there is no propagation to stop.
 */
export function TeamMemberCard({
  member,
  owner,
  onSelectOwner,
  onOpenProfile,
  ownedAgentCount,
  layoutAnimated = false,
  ref,
  className,
}: TeamMemberCardProps) {
  const face = teamMemberFace(member);

  return (
    <motion.article
      ref={ref}
      {...(layoutAnimated ? LAYOUT_MOTION : {})}
      data-slot="team-member-card"
      data-member-id={member.id}
      // The card's half of the gate the grid reports on its root. Emitted from
      // the same prop that decides the motion props above, so a grid that
      // stopped passing it cannot leave the root attribute claiming otherwise —
      // which is the only drift jsdom can catch here, since `test-setup.ts`
      // strips every motion prop before it reaches the DOM.
      data-layout-animated={String(layoutAnimated)}
      // The card wears this identity's own colour, and paints its border from
      // it at a STRENGTH the stylesheet can move. Two things force this shape:
      //
      // - An ancestor cannot inherit a property its child declares, so the card
      //   publishes the face colour itself rather than reading it off the disc.
      // - `index.css` sets a neutral `border-color` on `*` in an UNLAYERED
      //   rule, and an unlayered rule outranks every `@layer` — Tailwind's
      //   utilities included. No `border-<colour>` class can change a border in
      //   this app (see the note in `contributing/design-system.md`). An inline
      //   declaration does outrank it, so the colour is painted here and only
      //   its strength moves, through a custom property a class CAN set.
      style={
        {
          '--identity-color': face.color,
          borderColor:
            'color-mix(in oklch, var(--identity-color) var(--identity-border-strength), hsl(var(--border)))',
        } as CSSProperties
      }
      className={cn(
        'bg-card shadow-soft relative flex items-start gap-3 rounded-lg border p-4',
        // The resting strength is a CLASS, not part of the inline style above:
        // an inline declaration outranks every stylesheet rule, so a resting
        // value written inline would be one the `hover:` step could never move.
        // Only what must beat the unlayered `*` border default stays inline.
        '[--identity-border-strength:0%]',
        onOpenProfile && [
          // Surface tier: the whole area is one action, so the whole card
          // answers — it lifts a hair, its shadow steps up, and its border
          // firms into this identity's own colour. Named properties rather
          // than `transition-all`, so what moves stays auditable; every one of
          // them is paint or transform, so nothing reflows. `translate` and
          // `scale` are named as themselves because Tailwind v4 writes those
          // properties directly — listing `transform` transitions nothing.
          'transition-[box-shadow,border-color,translate,scale] duration-(--identity-settle) ease-(--identity-ease-standard)',
          'hover:shadow-elevated hover:-translate-y-px',
          'hover:[--identity-border-strength:var(--identity-border-mix)]',
          // Focus-visible parity, on the CARD rather than only on the word. A
          // keyboard reaching the primary control must learn what a pointer
          // learns: the whole tile is the target. Without this, Tab drew a ring
          // around a name while a mouse got the whole card answering — and the
          // negative twin below (standing down for the attribution's focus)
          // already existed, which is what made the gap an oversight.
          'has-[[data-slot=team-member-open]:focus-visible]:shadow-elevated has-[[data-slot=team-member-open]:focus-visible]:-translate-y-px',
          'has-[[data-slot=team-member-open]:focus-visible]:[--identity-border-strength:var(--identity-border-mix)]',
          'active:translate-y-0 active:scale-[0.99] active:duration-(--identity-press)',
          // Per-area stand-down: hovering the attribution — a DIFFERENT action
          // inside the same card — calms the card, so one pointer never lights
          // two affordances at once and each area telegraphs its OWN verb.
          //
          // Scoped to the attribution by name, not to `button:hover`. The
          // card's primary control is the name button, whose `after:` overlay
          // covers the whole tile; a pseudo-element hit-tests as part of the
          // element that generated it, so `has-[button:hover]` would be true
          // everywhere on the card and the lift would never fire at all.
          'has-[[data-slot=team-member-owner]:hover]:shadow-soft has-[[data-slot=team-member-owner]:hover]:translate-y-0 has-[[data-slot=team-member-owner]:hover]:[--identity-border-strength:0%]',
          'has-[[data-slot=team-member-owner]:focus-visible]:shadow-soft has-[[data-slot=team-member-owner]:focus-visible]:translate-y-0 has-[[data-slot=team-member-owner]:focus-visible]:[--identity-border-strength:0%]',
          // `:active` propagates to ancestors, so without this the card would
          // shrink under a press the stand-down had only just calmed — the
          // press echoing on the surface that is deliberately NOT answering.
          'has-[[data-slot=team-member-owner]:active]:scale-100',
        ],
        className
      )}
    >
      <IdentityAvatar
        size="md"
        kind={face.kind}
        color={face.color}
        emoji={face.emoji}
        imageUrl={face.imageUrl}
        fallback={face.fallback}
        origin={face.origin}
        // The disc takes no hover ring — the card's own border is already this
        // identity answering, and a second colour response on the same hover
        // would be one fact drawn twice. It does wake its badge, and only when
        // there is a profile to open: the wake says "you are pointing at
        // something that answers", which is false on a read-only tile.
        className={onOpenProfile ? IDENTITY_BADGE_WAKE : undefined}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <h3 className="min-w-0 truncate text-sm font-medium">
            {onOpenProfile ? (
              // `after:` stretches this button's hit area over the whole card
              // (the `relative` article above is what it pins to). The visible
              // text names who; the label names what pressing it does, the same
              // split the attribution below already makes.
              <button
                type="button"
                // Named so the card can answer this control's keyboard focus
                // the way it answers a pointer — see the `has-[…]` rules on the
                // article above.
                data-slot="team-member-open"
                onClick={() => onOpenProfile(member.id)}
                aria-label={`Open ${member.displayName}’s profile`}
                className="focus-ring max-w-full truncate rounded text-left after:absolute after:inset-0 after:rounded-lg after:content-['']"
              >
                {member.displayName}
              </button>
            ) : (
              member.displayName
            )}
          </h3>
          {/* A flag on a row, never a branch: the card is the same card. */}
          {member.isSelf && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[0.625rem]">
              you
            </Badge>
          )}
          {member.agent?.isDefault && (
            <Badge variant="outline" className="px-1.5 py-0 text-[0.625rem]">
              default
            </Badge>
          )}
        </div>
        {/* Absent rather than `@` — a handle nobody has is not a handle that
            reaches nobody, and an empty `@` is the second of those. */}
        {member.handle !== null && (
          <p data-slot="team-member-handle" className="text-muted-foreground truncate text-xs">
            @{member.handle}
          </p>
        )}
        <p className="text-muted-foreground mt-1.5 truncate text-xs">{secondaryLine(member)}</p>
        {member.agent?.recentlyActive && (
          <p className="text-muted-foreground mt-0.5 text-xs">Active in the last hour</p>
        )}
        {owner && onSelectOwner && (
          // A row rather than the bare button, because the hover echo sits
          // beside the attribution and has to hold its own width at rest —
          // see the reserved span below.
          <div className="mt-1.5 flex min-w-0 items-baseline gap-1">
            <button
              type="button"
              // Named so the card can stand down for exactly this control and
              // no other — see the `has-[…]` rules on the article above.
              data-slot="team-member-owner"
              onClick={() => onSelectOwner(owner.id)}
              // The visible text names the owner; the label names what pressing
              // it does, which is the part a screen reader cannot infer from
              // "by @dorian".
              aria-label={`Show only ${owner.displayName} and their agents`}
              // `relative` lifts this above the name button's card-wide
              // overlay: positioned, and later in the DOM, so it paints on top
              // and takes its own press. Without it the overlay would swallow
              // every click here and the attribution would silently open a
              // profile instead.
              // Chip tier on a text surface: the text steps up to full
              // foreground colour and an underline arrives. The
              // `focus-visible:` twins are not decoration — a keyboard user
              // must never learn less than a mouse user, and the ring alone
              // says "you are here", not "this filters".
              // `peer/owner` is what the echo beside it listens to.
              className="text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-ring peer/owner relative min-w-0 truncate rounded text-xs underline-offset-2 transition-[color] duration-(--identity-answer) ease-(--identity-ease-standard) hover:underline focus-visible:underline"
            >
              by {teamMemberLabel(owner)}
            </button>
            {ownedAgentCount !== undefined && ownedAgentCount > 0 && (
              // The echo: what narrowing to this person would leave behind.
              //
              // **It holds its width at rest.** Animating width is banned
              // outright (spec §2.3) — it reflows — and a suffix that appeared
              // by taking space would shove the name under the cursor, which is
              // the one thing a preview must not do. So the space is reserved
              // permanently and only `opacity` moves. The cost is stated rather
              // than hidden: a very long handle truncates a little sooner than
              // it used to.
              //
              // Reduced motion needs nothing here. This is a CSS transition, so
              // the global reset in `index.css` collapses it and the count
              // simply appears — the end state carries the whole meaning, which
              // is the test every state in this grammar has to pass.
              //
              // `aria-hidden` and `pointer-events-none`: the fact is already on
              // screen as cards, the button's own label names the action, and a
              // decoration that ate hovers would be a target pretending not to
              // be one.
              //
              // **It does not exist at all where there is no hover.** This is a
              // preview of a tap that a touch screen performs directly, so on a
              // phone it could never be seen — and reserving its width there
              // would spend the attribution's space on something that can never
              // repay it. Caught in a browser at 375px, where "by
              // @miguel.telegram" truncated to make room for a suffix no finger
              // can summon. `hover: hover` is the honest query for that: it
              // asks about the pointer, not the viewport, so a narrow desktop
              // window still gets the echo it can actually use.
              <span
                aria-hidden
                data-slot="team-member-owner-count"
                className="text-muted-foreground pointer-events-none hidden shrink-0 text-xs opacity-0 transition-opacity duration-(--identity-answer) ease-(--identity-ease-standard) peer-hover/owner:opacity-100 peer-focus-visible/owner:opacity-100 [@media(hover:hover)]:inline"
              >
                · {ownedAgentCount} {ownedAgentCount === 1 ? 'agent' : 'agents'}
              </span>
            )}
          </div>
        )}
      </div>
    </motion.article>
  );
}
