import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from '@/layers/shared/lib/utils';
import { STATUS_TONE_TEXT } from './status-dot';

const badgeVariants = cva(
  'inline-flex items-center rounded-md border font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'text-foreground',
      },
      // The two sizes that actually exist. Before this axis, two thirds of the
      // badges in the app corrected the primitive from the call site — 30 of
      // them re-stating the size it already had, 32 shrinking it by hand.
      size: {
        sm: 'px-2 py-0.5 text-xs',
        xs: 'px-1.5 py-0 text-3xs',
      },
      // Declared AFTER `variant` on purpose: a tone is a colour correction on
      // top of a shape, so tailwind-merge must see it last for it to win.
      tone: STATUS_TONE_TEXT,
    },
    defaultVariants: {
      variant: 'default',
      size: 'sm',
    },
  }
);

/** Everything a badge draws — shape, size, and an optional status colour. */
export interface BadgeProps
  extends React.ComponentProps<'span'>, VariantProps<typeof badgeVariants> {
  /** Render the caller's own element as the badge — a link, a button, a `<dd>`. */
  asChild?: boolean;
}

/**
 * A small inline label: a count, a state, a category.
 *
 * A `<span>`, so it is legal inside a sentence — as a `<div>` it was invalid
 * HTML inside every `<p>` it landed in, which React renders without complaint
 * and a validator does not. `asChild` is how it becomes something else: a badge
 * that navigates should BE the link, not sit inside one.
 *
 * `tone` is separate from `variant` because they answer different questions.
 * `variant` is the shape (filled, quiet, outlined); `tone` is what the state
 * means, and it spends the app's shared `--status-*` colours so a warning badge
 * is the same amber as a warning banner in both themes.
 *
 * @param asChild - Render the child element instead of a `<span>`.
 * @param variant - Fill treatment. Defaults to `default`.
 * @param size - `sm` (12px) or `xs` (10px). Defaults to `sm`.
 * @param tone - Status colour override, from the shared tone vocabulary.
 */
function Badge({
  className,
  variant = 'default',
  size = 'sm',
  tone,
  asChild = false,
  ...props
}: BadgeProps) {
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant, size, tone }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
