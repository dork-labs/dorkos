/**
 * The tinted disc every identity in the cockpit is drawn as.
 *
 * @module shared/ui/identity-avatar
 */
import type * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { readableForeground } from '../lib/readable-foreground';
import { cn } from '../lib/utils';

/**
 * How much of the identity's own colour tints the disc in the default
 * `tint` variant.
 *
 * One number for every avatar in the cockpit: enough colour to tell two
 * identities apart at a glance, faint enough that the glyph on top stays
 * legible in both themes.
 */
const TINT_STRENGTH = '18%';

const identityAvatarVariants = cva(
  'relative inline-flex shrink-0 items-center justify-center transition-[background-color] duration-500 ease-in-out',
  {
    variants: {
      size: {
        xs: 'size-5 text-xs',
        sm: 'size-7 text-sm',
        md: 'size-9 text-lg',
        lg: 'size-12 text-2xl',
      },
      /**
       * Square is the agent shape, circle the person shape — a colourblind-safe
       * distinction that does not depend on the badge rendering (spec
       * `composer-identity-components`, direction C). The base radius here is
       * `xs`'s: a fixed radius that reads fine on a 48px `lg` disc clamps to a
       * full circle on a 20px `xs` one — 12px of corner rounding on a 20px box
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
    // sized for `xs` (20px) and stays the `shape` default above; `sm`/`md`/`lg`
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

export interface IdentityAvatarProps
  extends React.ComponentProps<'span'>, VariantProps<typeof identityAvatarVariants> {
  /** CSS colour string the disc is tinted from. Any colour space the browser reads. */
  color: string;
  /** The identity's own emoji, when it has one — the face this prefers. */
  emoji?: string;
  /** Drawn when there is no emoji: usually a letter, sometimes a brand mark. */
  fallback?: React.ReactNode;
  /**
   * A small mark in the disc's bottom-right corner saying what KIND of identity
   * this is. Omit it and nothing is drawn.
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
   */
  badge?: React.ReactNode;
}

/**
 * A round, colour-tinted mark for one identity — a person, an agent, a room's
 * counterpart. Presentational only: it knows a colour, an optional emoji, and
 * what to draw without one, and nothing about where any of those came from.
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
 * **Stays kind-agnostic on purpose.** `shape` (circle/square) and `variant`
 * (tint/fill) are the disc's whole vocabulary for telling one kind of
 * identity from another — the mapping from an actual `kind` (agent, person,
 * external person) to a `{ shape, variant, badge }` triple belongs to the
 * caller, the same way it already does for `badge`. A room importing this
 * component never needs `entities/agent` to draw an agent square.
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
  badge,
  size,
  shape,
  variant,
  className,
  style,
  children,
  ...props
}: IdentityAvatarProps) {
  const isFill = variant === 'fill';

  return (
    <span
      data-slot="identity-avatar"
      {...props}
      className={cn(identityAvatarVariants({ size, shape, variant }), className)}
      // The background is a per-identity colour — carried on the record or
      // hashed from an id — that Tailwind cannot know at build time, so this
      // is the one place a colour is written inline rather than as a theme
      // token. `fill` uses the colour outright; `tint` mixes it toward
      // transparent over whatever surface the disc sits on. `fill` also has
      // to pick the fallback letter's own colour rather than trust it will
      // read against an arbitrary background — `readableForeground` is the
      // same "don't assume white" call this inline exception already makes
      // for the background.
      style={{
        backgroundColor: isFill
          ? color
          : `color-mix(in oklch, ${color} ${TINT_STRENGTH}, transparent)`,
        ...(isFill ? { color: readableForeground(color) } : {}),
        ...style,
      }}
    >
      {emoji ? (
        <span aria-hidden className="leading-none">
          {emoji}
        </span>
      ) : (
        <span aria-hidden className="text-[0.8em] leading-none font-medium">
          {fallback}
        </span>
      )}
      {badge !== undefined && (
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
          className="bg-background text-muted-foreground pointer-events-none absolute -right-px -bottom-px inline-flex size-[1.35em] items-center justify-center rounded-full text-[0.62em] leading-none [&_svg:not([class*='size-'])]:size-[1em]"
        >
          {badge}
        </span>
      )}
      {children}
    </span>
  );
}

export { IdentityAvatar, identityAvatarVariants };
