/**
 * The tinted disc every identity in the cockpit is drawn as.
 *
 * @module shared/ui/identity-avatar
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import type { AuthorKind } from '@dorkos/shared/room-schemas';
import { readableForeground } from '../lib/readable-foreground';
import { cn } from '../lib/utils';
import type { IdentityOrigin } from '../lib/identity-origin';
import { AGENT_GLYPH, platformGlyph } from './identity-glyphs';
import {
  STATUS_DOT_COLOR,
  STATUS_DOT_HALO,
  STATUS_DOT_LABEL,
  type IdentityStatus,
} from './status-dot';

/**
 * How much of the identity's own colour tints the disc in the default
 * `tint` variant.
 *
 * One number for every avatar in the cockpit: enough colour to tell two
 * identities apart at a glance, faint enough that the glyph on top stays
 * legible in both themes.
 */
const TINT_STRENGTH = '18%';

/**
 * The class a disc wears so its kind badge **wakes** when a pointer arrives on
 * the face — the Bot mark tilts a few degrees and grows a tenth.
 *
 * **Opt-in per call site, and that is the whole design.** The wake says "you
 * are pointing at something that answers", so it belongs only where the disc is
 * part of a target: the roster card, an identity lockup, an account button, a
 * room's member discs. In the sidebar — twenty-plus rows whose discs are not
 * targets — a badge that stirred under the cursor would promise an action that
 * is not there. {@link identityMarkRing} carries this class already, because a
 * disc wearing the Mark tier is a target by definition; a Surface-tier caller
 * (the Team card, whose border is the card's own answer) adds it by hand.
 *
 * **Named, for the reason the Mark group is named.** A bare `group-hover:`
 * compiles to `:where(.group):hover &` and matches ANY `.group` ancestor rather
 * than the nearest — which is how the sidebar's pane-wide unnamed group left
 * every face permanently ringed in slice 1. `group/avatar` matches the disc
 * that opted in and nothing else.
 */
const IDENTITY_BADGE_WAKE = 'group/avatar';

/**
 * The **Mark tier** of the identity interaction grammar: a disc that is itself
 * a target answers a pointer by ringing itself in its OWN colour, one step
 * quieter than full strength (`--identity-ring-mix`).
 *
 * A ring is a change in _state_, not in size — nothing moves, nothing reflows,
 * and the end state reads on its own, which is what makes it correct under
 * `prefers-reduced-motion` for free (`index.css` collapses every transition
 * duration there, so only the destination survives; see the design spec §2.6).
 *
 * Two drivers, because a disc is a target in two different shapes:
 *
 * - `self` — the disc is the hovered thing itself, and nothing can focus it (a
 *   tooltip trigger in a room roster). No `focus-visible` twin, deliberately: a
 *   focus ring on a `<span>` no keyboard can reach is an affordance wired to
 *   nothing, which is the defect this grammar exists to remove, not add.
 * - `group` — the disc sits inside a real control that owns the hover and the
 *   focus (a face button, an identity lockup). Pair it with
 *   {@link IDENTITY_MARK_GROUP} on that control and the ring answers a keyboard
 *   exactly as it answers a mouse.
 *
 * **The group is NAMED, and that is load-bearing.** Tailwind compiles a bare
 * `group-hover:` to `:where(.group):hover &`, which matches ANY `.group`
 * ancestor rather than the nearest one. The sidebar wraps its rows in an
 * unnamed `.group` that spans most of the pane, so the bare form left every
 * sidebar face permanently ringed — a hover state that was never not on.
 * Caught in a browser; jsdom cannot see it. `group/identity` matches only the
 * control that opted in.
 *
 * **Nothing competes for the ring any more.** `AgentAvatar` used to spend the
 * same 2px on a mesh-health ring, so a pressable disc carrying health took no
 * hover ring at all and its lockup fell back to a neutral row hover. That ring
 * is gone (DOR-1052) — health is drawn where health is the subject — and the
 * identity's own colour is now the only thing this slot ever holds.
 *
 * The transition names `background-color` alongside `box-shadow` so the disc's
 * own colour crossfade is not silently dropped by class merging; on a Mark disc
 * both run at `--identity-answer`.
 */
const identityMarkRing = {
  /** The disc is the hover target itself and is not focusable. */
  self: `ring-0 ring-[color-mix(in_oklch,var(--identity-color)_var(--identity-ring-mix),transparent)] transition-[background-color,box-shadow] duration-(--identity-answer) ease-(--identity-ease-out) hover:ring-2 ${IDENTITY_BADGE_WAKE}`,
  /** The disc sits inside a control marked {@link IDENTITY_MARK_GROUP}. */
  group: `ring-0 ring-[color-mix(in_oklch,var(--identity-color)_var(--identity-ring-mix),transparent)] transition-[background-color,box-shadow] duration-(--identity-answer) ease-(--identity-ease-out) group-hover/identity:ring-2 group-focus-visible/identity:ring-2 ${IDENTITY_BADGE_WAKE}`,
} as const;

/**
 * The class a control wears so the {@link identityMarkRing}`.group` disc inside
 * it answers that control's hover and focus — and nothing else's.
 *
 * Exported rather than spelled out per call site so the name cannot drift: a
 * `group` here and a `group-hover/identity:` there is a ring that never fires,
 * and nothing would report it.
 */
const IDENTITY_MARK_GROUP = 'group/identity';

const identityAvatarVariants = cva(
  'relative inline-flex shrink-0 items-center justify-center transition-[background-color] duration-500 ease-in-out',
  {
    variants: {
      size: {
        // 18px, exactly the row's glyph slot (`--sidebar-row-x` + 18). It was
        // 20, which meant a single-face direct message sat 2px proud of the `#`
        // above it and 2px proud of the agent face below it — three marks in one
        // column, each starting somewhere slightly different (D1).
        xs: 'size-[18px] text-xs',
        sm: 'size-7 text-sm',
        md: 'size-9 text-lg',
        lg: 'size-12 text-2xl',
      },
      /**
       * Square is the agent shape, circle the person shape — a colourblind-safe
       * distinction that does not depend on the badge rendering (spec
       * `composer-identity-components`, direction C). The base radius here is
       * `xs`'s: a fixed radius that reads fine on a 48px `lg` disc clamps to a
       * full circle on an 18px `xs` one — 12px of corner rounding on an 18px box
       * IS a circle — which would erase the shape distinction exactly where the
       * design calls it dominant (the picker, the sidebar). `compoundVariants`
       * below step the radius up with the diameter instead.
       */
      shape: {
        circle: 'rounded-full',
        square: 'rounded-md',
      },
      /**
       * `tint` (the long-standing look) mixes the colour into the surface behind
       * it; `fill` makes the colour the disc itself. Carries no classes of its
       * own — both the background and, for `fill`, the fallback letter's
       * foreground are per-identity colours computed at render time, so they go
       * through inline `style` the same way the tint mix already does. The slot
       * exists so callers get `variant` in the component's own type rather than
       * inferring it from a boolean.
       */
      variant: {
        tint: '',
        fill: '',
      },
    },
    // The square radius steps up with the diameter — `rounded-md` (6px) is
    // sized for `xs` (18px) and stays the `shape` default above; `sm`/`md`/`lg`
    // override it here rather than in `size`, because `size` also drives
    // `circle`, which has no radius to scale (`rounded-full` is already
    // correct at every diameter).
    compoundVariants: [
      { shape: 'square', size: 'sm', class: 'rounded-lg' },
      { shape: 'square', size: 'md', class: 'rounded-xl' },
      { shape: 'square', size: 'lg', class: 'rounded-2xl' },
    ],
    defaultVariants: {
      size: 'sm',
      shape: 'circle',
      variant: 'tint',
    },
  }
);

/** The three decisions a `kind` makes on a caller's behalf. */
interface KindDefaults {
  shape: NonNullable<VariantProps<typeof identityAvatarVariants>['shape']>;
  variant: NonNullable<VariantProps<typeof identityAvatarVariants>['variant']>;
  badge: React.ReactNode;
}

/** What an identity with no declared kind draws — the pre-`kind` defaults. */
const UNDECLARED: KindDefaults = { shape: 'circle', variant: 'tint', badge: undefined };

/**
 * The design-handoff rules, made code: agent is a filled square wearing the
 * Bot mark, everyone else is a tinted circle, and a person bridged in from
 * another platform carries that platform's own brand mark.
 *
 * `origin` is only read for a human, because it is only ever true of one: an
 * agent and the room's own voice are on this machine by construction.
 */
function defaultsForKind(
  kind: AuthorKind | undefined,
  origin: IdentityOrigin | undefined
): KindDefaults {
  // Both marks come from the shared registry (`identity-glyphs.ts`), not from
  // `lucide-react` directly: the trailing session mark draws the same Bot for
  // the same reason, and two independent imports of one product decision drift
  // the first time either moves.
  const Agent = AGENT_GLYPH;
  if (kind === 'agent') return { shape: 'square', variant: 'fill', badge: <Agent /> };
  if (kind !== 'human' || typeof origin !== 'object' || origin === null) return UNDECLARED;

  const Logo = platformGlyph(origin.platform);
  return { ...UNDECLARED, badge: <Logo /> };
}

export interface IdentityAvatarProps
  extends React.ComponentProps<'span'>, VariantProps<typeof identityAvatarVariants> {
  /** CSS colour string the disc is tinted from. Any colour space the browser reads. */
  color: string;
  /** The identity's own emoji, when it has one. Drawn when there is no photo. */
  emoji?: string;
  /** Drawn when there is neither a photo nor an emoji: usually a letter, sometimes a brand mark. */
  fallback?: React.ReactNode;
  /**
   * The identity's photo, when it has one — the face this prefers.
   *
   * **Source-agnostic.** Whatever URL the caller holds is used as given: a
   * server-relative `/api/profile/avatar/…` from this machine's own store, or
   * an absolute `https://…` from a synced one. This component never builds a
   * path and never assumes the bytes are local.
   *
   * Absence is drawn as the emoji, and a URL whose bytes have gone falls back
   * to the same place. Both are STRUCTURAL: with no photo no `<img>` is
   * rendered at all, because an `<img>` with an empty `src` paints the
   * browser's own broken-image icon and no styling un-paints it.
   */
  imageUrl?: string;
  /**
   * A small mark in the disc's bottom-right corner saying what KIND of identity
   * this is. Omit it and `kind` decides; omit both and nothing is drawn.
   *
   * **The convention is: agents get the glyph, people get nothing.** Absence is
   * the signal, the same way it is everywhere else in this cockpit — a badge on
   * every row would be a column of identical marks saying nothing, and a badge
   * reading "person" would put the burden of proof on the humans.
   *
   * This exists because a room may not reach the agent components at all: the
   * FSD layer rule stops `entities/room` importing `entities/agent`, and the
   * last time a roster needed to mark an agent apart it invented a second
   * identity system rather than break the rule. A slot on the shared disc is
   * the legal way to say it.
   *
   * Decoration only. It takes no pointer events — a mark this size inside a
   * 20px disc would be a mis-tap on a touch screen, and it is not a control —
   * and it contributes nothing to the accessibility tree, because the row's own
   * text already names what the member is.
   *
   * `null` is the explicit "no badge here", which an agent-only list uses to
   * keep the shape and drop a column of identical glyphs. It is a decision
   * the call site can be seen making, unlike omitting the prop.
   */
  badge?: React.ReactNode;
  /**
   * What this identity IS. Supplying it derives `shape`, `variant` and
   * `badge` so a caller cannot draw an agent as a person by forgetting three
   * props — the failure this component shipped with, in 18 of the 20 places
   * that draw one.
   *
   * | `kind`                          | shape    | variant | badge                            |
   * | ------------------------------- | -------- | ------- | -------------------------------- |
   * | `agent`                         | `square` | `fill`  | Bot                              |
   * | `human`, local or absent origin | `circle` | `tint`  | none — absence is the signal     |
   * | `human`, bridged origin         | `circle` | `tint`  | the platform's mark, else Send   |
   * | `system`                        | `circle` | `tint`  | none                             |
   * | _omitted_                       | `circle` | `tint`  | none                             |
   *
   * Explicit props still win: pass `shape`, `variant` or `badge` and the
   * derivation steps aside for that axis only. Omitting `kind` reproduces the
   * pre-`kind` defaults exactly, so this is additive and no existing call
   * site changes meaning.
   *
   * The spelling is the repo's own (`AuthorKind`), not a second vocabulary:
   * "circle is the person shape" is a sentence for docs, never a value on the
   * wire. A caller holding `author.kind` passes it straight through.
   */
  kind?: AuthorKind;
  /**
   * Where a human is posting from. Read only to derive the external badge —
   * an agent and the room's own voice are on this machine by construction.
   */
  origin?: IdentityOrigin;
  /**
   * What this identity is doing right now — the dot in the disc's **top-right**
   * corner, opposite the badge.
   *
   * The corner has exactly one job, and this is it. Green and pulsing means a
   * turn is streaming as you look at it; amber means something is waiting on
   * you; red means something broke; `idle` (the default) draws nothing, because
   * a cockpit where every face wears a dot is a cockpit with no signal in it.
   * See {@link IdentityStatus}.
   *
   * **Only `working` moves.** Motion is what says "right now" — an amber dot
   * that pulsed would claim a blocked turn is still running. The pulse, not the
   * dot, is what `motion-reduce` drops, so the fact survives the preference.
   *
   * Kind-agnostic on purpose: an agent mid-turn and a person mid-task are the
   * same fact to a roster, and both read it at a glance rather than from a
   * hover.
   */
  status?: IdentityStatus;
}

/**
 * A round, colour-tinted mark for one identity — a person, an agent, a room's
 * counterpart. Presentational only: it knows a colour, an optional photo, an
 * optional emoji, and what to draw without either — and nothing about where any
 * of those came from.
 *
 * **Three faces, one order: photo, then emoji, then the fallback glyph.** They
 * are alternatives rather than layers, and the choice is structural: with no
 * photo there is no `<img>` in the tree at all, so an identity that has never
 * had one cannot flash the browser's broken-image icon. A photo whose bytes
 * have gone falls back to the same place, once, and is retried if the URL
 * changes.
 *
 * This is the single disc the whole cockpit draws. It exists because four
 * surfaces had each hand-rolled the same `color-mix` tint, and one of them —
 * a room — could not reach the agent component at all without breaking the FSD
 * layer rule, so it invented a second identity system instead.
 *
 * A letter reads a step smaller than an emoji at the same diameter, so the
 * fallback glyph is sized relative to the circle's own font size: one rule
 * covers every size rather than a lookup per size per face.
 *
 * **Tell it what the identity IS and it draws the rest.** `kind` derives
 * `shape` (circle/square), `variant` (tint/fill) and `badge` together, because
 * a caller asked to make those three decisions by hand made them wrong in 18
 * of the 20 places that draw an agent. Explicit props still win per axis, and
 * omitting `kind` reproduces the pre-`kind` defaults exactly.
 *
 * It stays presentational: it reads a kind, it never fetches or resolves one.
 * A room importing this component never needs `entities/agent` to draw an
 * agent square — which is the whole reason the mapping lives here rather than
 * in the agent entity.
 *
 * Contributes nothing to the accessibility tree on its own — an emoji has a
 * spoken name nobody asked to hear. Give it a sibling label, or an `sr-only`
 * child when the mark stands alone.
 *
 * @param props.children - Decoration layered on the disc, such as a status dot.
 *   The disc is the positioning context, so an absolutely-placed child anchors
 *   to it.
 */
function IdentityAvatar({
  color,
  emoji,
  fallback,
  imageUrl,
  badge,
  kind,
  origin,
  status = 'idle',
  size,
  shape,
  variant,
  className,
  style,
  children,
  ...props
}: IdentityAvatarProps) {
  // Per axis, not per identity: a caller that wants an agent drawn round
  // still gets its fill and its badge. `badge` is compared against
  // `undefined` rather than falsiness, because `null` is a caller saying
  // "none" and has to survive the derivation.
  const defaults = defaultsForKind(kind, origin);
  const drawnShape = shape ?? defaults.shape;
  const drawnVariant = variant ?? defaults.variant;
  const drawnBadge = badge === undefined ? defaults.badge : badge;
  const isFill = drawnVariant === 'fill';
  // The URL that failed, rather than a boolean, so a REPLACED photo is tried
  // again. A person who uploads a new one after a bad file would otherwise be
  // stuck on the letter until the page reloaded.
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
  const drawsPhoto = imageUrl !== undefined && imageUrl !== failedUrl;

  // One face, chosen once: photo, then emoji, then the fallback glyph. A
  // ladder rather than nested ternaries in the markup, so the precedence is
  // the thing you read — and so "no photo" means no `<img>` in the tree at
  // all, which is the only way an absent photo cannot paint a broken-image
  // icon.
  let face: React.ReactNode;
  if (drawsPhoto) {
    face = (
      <img
        src={imageUrl}
        // Decoration, like every other face this disc draws: the row's own
        // text names the identity, and "photo of Dorian" spoken before each of
        // their messages is noise. `alt=""` is what keeps it out of the
        // accessibility tree rather than announcing a filename.
        alt=""
        // The radius is inherited rather than restated, so a photo cannot round
        // an agent's square back into a person's circle — the shape
        // distinction is colourblind-safe and must not depend on the face.
        className="size-full rounded-[inherit] object-cover"
        // A URL whose bytes have gone — a deleted file, an expired object —
        // falls back to the face this identity had before it ever had a photo.
        onError={() => setFailedUrl(imageUrl)}
      />
    );
  } else if (emoji) {
    face = (
      <span aria-hidden className="leading-none">
        {emoji}
      </span>
    );
  } else {
    face = (
      <span aria-hidden className="text-[0.8em] leading-none font-medium">
        {fallback}
      </span>
    );
  }

  return (
    <span
      data-slot="identity-avatar"
      // Which face this disc settled on, in one readable value.
      //
      // **For the tests that have to catch a face CHANGING.** An agent drawn
      // from its directory's hash and an agent drawn from its manifest are two
      // different emoji, and the defect that costs (DOR-1143) is the row
      // swapping one for the other a beat after it painted. Reading that from
      // the DOM otherwise means reaching into whichever of three branches drew
      // the face, and the emoji branch is an `aria-hidden` span a query has no
      // business knowing about. One attribute, always present, so a browser test
      // can compare first paint against settled without knowing any of that.
      // `fallback` is a node — usually a letter, sometimes a brand mark — so
      // only the letter case can name itself here; a mark reads as "glyph".
      data-face={
        drawsPhoto ? 'photo' : (emoji ?? (typeof fallback === 'string' ? fallback : 'glyph'))
      }
      {...props}
      className={cn(
        identityAvatarVariants({ size, shape: drawnShape, variant: drawnVariant }),
        className
      )}
      // The background is a per-identity colour — carried on the record or
      // hashed from an id — that Tailwind cannot know at build time, so this
      // is the one place a colour is written inline rather than as a theme
      // token. `fill` uses the colour outright; `tint` mixes it toward
      // transparent over whatever surface the disc sits on. `fill` also has
      // to pick the fallback letter's own colour rather than trust it will
      // read against an arbitrary background — `readableForeground` is the
      // same "don't assume white" call this inline exception already makes
      // for the background.
      style={
        {
          // Published so a STYLESHEET can reach this identity's colour. An
          // inline `background-color` beats every rule in every stylesheet, so
          // for as long as the colour lived only there, no `:hover` could tint
          // it, ring it, or lend it to an ancestor's border — which is the
          // structural reason identity surfaces had no colour response at all.
          // A custom property inherits, so the disc, its descendants, and any
          // ancestor that sets the same property can all read it from a class
          // string. Purely additive: nothing below changes behaviour. Follows
          // `--runtime-accent` (`RuntimeCardView.tsx`) exactly.
          '--identity-color': color,
          backgroundColor: isFill
            ? color
            : `color-mix(in oklch, ${color} ${TINT_STRENGTH}, transparent)`,
          ...(isFill ? { color: readableForeground(color) } : {}),
          ...style,
        } as React.CSSProperties
      }
    >
      {face}
      {drawnBadge != null && (
        // Sized off the circle's own font size, exactly as the fallback glyph
        // is, so one rule covers all four diameters instead of a lookup per
        // size. `text-[0.62em]` sets the mark; `size-[1.35em]` is 1.35 of THAT
        // — 0.84 of the disc's font size, which lands the plate near 42% of the
        // disc at `sm` and up and 50% at `xs`, where the font runs a step
        // larger than the circle. Deliberately generous at `xs`: a 20px disc is
        // most of where this ends up (the picker list, the sidebar), and a mark
        // that scaled by diameter alone would be a smudge there.
        //
        // The plate is the page background rather than a border, which is what
        // lets it read over any disc colour: the tint stops at its edge. A ring
        // would do the same job and cost 4px, which a 20px disc does not have.
        <span
          aria-hidden
          data-slot="identity-badge"
          className={cn(
            "bg-background text-muted-foreground pointer-events-none absolute -right-px -bottom-px inline-flex size-[1.35em] items-center justify-center rounded-full text-[0.62em] leading-none [&_svg:not([class*='size-'])]:size-[1em]",
            // The wake. Dormant unless an ancestor opted in with
            // `IDENTITY_BADGE_WAKE`, so a disc that is not a target does
            // nothing. It pivots about the corner it is pinned to, which is
            // what keeps a rotating plate inside the disc's own bounds instead
            // of swinging out past its edge.
            //
            // −6°, not more: at 8–12px the badge is a glyph on a plate, and
            // past about 8° the tilt stops reading as a gesture and starts
            // reading as a rendering fault.
            //
            // `motion-safe:` gates the END STATE, not just the travel — a
            // deliberate departure from the spec's §2.6 table, which would have
            // kept the tilt and dropped only the movement. The spec's own rule
            // for reduced motion is "keep the fact, drop the motion", and this
            // badge carries no fact: nothing about a 6° tilt tells you
            // anything a still badge does not. With no fact to keep, an instant
            // snap to a crooked badge is all cost, so the whole gesture goes.
            'origin-bottom-right transition-transform duration-(--identity-answer) ease-(--identity-ease-out)',
            'motion-safe:group-hover/avatar:scale-110 motion-safe:group-hover/avatar:-rotate-6'
          )}
        >
          {drawnBadge}
        </span>
      )}
      {status !== 'idle' && (
        // Opposite the badge, so an agent can wear both. The ring is the page
        // background rather than a border, for the same reason the badge's
        // plate is: it reads as separate from the disc over any tint, and a
        // 20px disc has no 4px to spare.
        //
        // The colour is the shared token map, not a green written here — the
        // sidebar, the tab strip and the group headers all spell the same three
        // states, and they used to spell them four different ways.
        //
        // NOT `aria-hidden`, unlike the identity badge below it. The badge
        // repeats something the surface around it already says (this is an
        // agent; this one came in over Telegram), so hiding it costs nothing.
        // This dot says something nothing else on the disc says, and it says it
        // in a hue — the one shape of signal a reader who cannot see it loses
        // entirely. So it carries its meaning as text too (spec R2), and the
        // words come from the shared map rather than from here.
        <span
          data-slot="identity-status-dot"
          data-status={status}
          className={cn(
            'ring-background absolute -top-px -right-px size-2 rounded-full ring-2',
            STATUS_DOT_COLOR[status]
          )}
        >
          <span className="sr-only">{STATUS_DOT_LABEL[status]}</span>
          {/* Only `working` gets the halo, because only `working` is happening
              RIGHT NOW — a still dot says the same thing about a state that
              began an hour ago, and "needs you" and "error" are states. The
              recipe is the shared one, so the corner and the row dots cannot
              end up disagreeing about which states move; `motion-reduce`
              removes the halo and leaves the dot beneath it, so the fact
              survives the preference and only the motion goes. */}
          {status === 'working' && (
            <span aria-hidden className={cn(STATUS_DOT_COLOR.working, STATUS_DOT_HALO)} />
          )}
        </span>
      )}
      {children}
    </span>
  );
}

export {
  IdentityAvatar,
  identityAvatarVariants,
  identityMarkRing,
  IDENTITY_MARK_GROUP,
  IDENTITY_BADGE_WAKE,
};
