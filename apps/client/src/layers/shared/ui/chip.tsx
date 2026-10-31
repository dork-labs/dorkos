/**
 * The interactive pill: a filter you can toggle, a suggestion you can take, the
 * trigger of a small popover.
 *
 * @module shared/ui/chip
 */
import * as React from 'react';
import { cva } from 'class-variance-authority';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';

/**
 * A 40px chip reaches 44 under a thumb without growing: a transparent
 * pseudo-element two pixels past each edge takes the hit. Below `md` only,
 * where the floor is 44.
 *
 * Spelled here until Button's `TOUCH_HIT_AREA` lands (Phase 2 Button PR A),
 * which this then imports.
 */
export const CHIP_HIT_AREA =
  "max-md:relative max-md:after:absolute max-md:after:inset-x-0 max-md:after:-inset-y-0.5 max-md:after:content-['']";

const chipVariants = cva(
  // Colour moves in 150ms; the press lands in 80ms and lets go in 120ms. Only
  // colour and scale are named, so nothing else on a chip ever animates.
  'focus-ring inline-flex shrink-0 cursor-pointer items-center rounded-full font-medium whitespace-nowrap transition-[color,background-color,scale] duration-[150ms,150ms,120ms] ease-out select-none motion-safe:active:scale-[0.98] motion-safe:active:duration-[150ms,150ms,80ms]disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
  {
    variants: {
      size: {
        sm: `h-6 gap-1 px-2.5 text-xs max-md:h-10 max-md:gap-1.5 max-md:px-3 [&>svg]:size-(--size-icon-xs) ${CHIP_HIT_AREA}`,
        md: 'h-8 gap-1.5 px-3 text-sm max-md:h-11 [&>svg]:size-(--size-icon-sm)',
      },
      pressed: {
        // Inverted, not a darker tint: 7% against 11% is about 1.1:1, so a
        // tinted selection would be colour-only and barely there.
        on: 'bg-foreground text-background hover:bg-foreground/90',
        off: 'bg-foreground/7 text-muted-foreground hover:bg-foreground/11 hover:text-foreground',
      },
    },
    defaultVariants: {
      size: 'sm',
      pressed: 'off',
    },
  }
);

/** Props for {@link Chip}. */
export interface ChipProps extends Omit<React.ComponentProps<'button'>, 'children'> {
  /** `sm` (24px, 40 on a phone) or `md` (32px, 44 on a phone). Defaults to `sm`. */
  size?: 'sm' | 'md';
  /**
   * A toggle's state: sets `aria-pressed` and inverts the chip. Omit it for an
   * action chip, which has no state to announce.
   */
  pressed?: boolean;
  /** A glyph before the words. */
  icon?: LucideIcon;
  /** Classes for the glyph: a status colour, when the chip carries one. */
  iconClassName?: string;
  /** What the chip says. Long text truncates; the full text goes in `title`. */
  children?: React.ReactNode;
}

/**
 * A pill you can press.
 *
 * A `<button>` with a forwarded ref, so it can be a Radix trigger. Rests on the
 * same 7% tint as a {@link Badge}; hovering steps it to 11% and the word to full
 * strength. A pressed toggle inverts to the foreground, which also keeps its
 * width: nothing shifts when it turns on.
 *
 * @param size - `sm` or `md`. Defaults to `sm`.
 * @param pressed - The toggle's state; omit for an action chip.
 * @param icon - A glyph before the words.
 * @param iconClassName - Classes for the glyph.
 */
const Chip = React.forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  {
    size = 'sm',
    pressed,
    icon: Icon,
    iconClassName,
    className,
    type = 'button',
    children,
    ...props
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      data-slot="chip"
      aria-pressed={pressed}
      className={cn(chipVariants({ size, pressed: pressed ? 'on' : 'off' }), className)}
      {...props}
    >
      {Icon && <Icon aria-hidden className={iconClassName} />}
      {children !== undefined && <span className="max-w-56 truncate">{children}</span>}
    </button>
  );
});

export { Chip, chipVariants };
