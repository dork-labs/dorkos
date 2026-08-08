import type { CSSProperties } from 'react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { Badge, IdentityAvatar } from '@/layers/shared/ui';
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
  className,
}: TeamMemberCardProps) {
  const face = teamMemberFace(member);

  return (
    <article
      data-slot="team-member-card"
      data-member-id={member.id}
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
          <button
            type="button"
            // Named so the card can stand down for exactly this control and no
            // other — see the `has-[…]` rules on the article above.
            data-slot="team-member-owner"
            onClick={() => onSelectOwner(owner.id)}
            // The visible text names the owner; the label names what pressing
            // it does, which is the part a screen reader cannot infer from
            // "by @dorian".
            aria-label={`Show only ${owner.displayName} and their agents`}
            // `relative` lifts this above the name button's card-wide overlay:
            // positioned, and later in the DOM, so it paints on top and takes
            // its own press. Without it the overlay would swallow every click
            // here and the attribution would silently open a profile instead.
            // Chip tier on a text surface: the text steps up to full foreground
            // colour and an underline arrives. The `focus-visible:` twins are
            // not decoration — a keyboard user must never learn less than a
            // mouse user, and the ring alone says "you are here", not "this
            // filters".
            className="text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-ring relative mt-1.5 max-w-full truncate rounded text-xs underline-offset-2 transition-[color] duration-(--identity-answer) ease-(--identity-ease-standard) hover:underline focus-visible:underline"
          >
            by {teamMemberLabel(owner)}
          </button>
        )}
      </div>
    </article>
  );
}
