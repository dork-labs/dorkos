/**
 * The tinted disc every identity in the cockpit is drawn as.
 *
 * @module shared/ui/identity-avatar
 */
import type * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';

/**
 * How much of the identity's own colour tints the disc.
 *
 * One number for every avatar in the cockpit: enough colour to tell two
 * identities apart at a glance, faint enough that the glyph on top stays
 * legible in both themes.
 */
const TINT_STRENGTH = '18%';

const identityAvatarVariants = cva(
  'relative inline-flex shrink-0 items-center justify-center rounded-full transition-[background-color] duration-500 ease-in-out',
  {
    variants: {
      size: {
        xs: 'size-5 text-xs',
        sm: 'size-7 text-sm',
        md: 'size-9 text-lg',
        lg: 'size-12 text-2xl',
      },
    },
    defaultVariants: {
      size: 'sm',
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
  className,
  style,
  children,
  ...props
}: IdentityAvatarProps) {
  return (
    <span
      data-slot="identity-avatar"
      {...props}
      className={cn(identityAvatarVariants({ size }), className)}
      // The tint mixes a per-identity colour — carried on the record or hashed
      // from an id — that Tailwind cannot know at build time, so this is the
      // one place a colour is written inline rather than as a theme token.
      style={{
        backgroundColor: `color-mix(in oklch, ${color} ${TINT_STRENGTH}, transparent)`,
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
