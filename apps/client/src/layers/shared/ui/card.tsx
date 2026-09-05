import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';

const cardVariants = cva('bg-card text-card-foreground shadow-soft flex flex-col border p-4', {
  variants: {
    // About ten files hand-wrote this shell rather than importing the component
    // — some because they wanted `rounded-xl`, some because they wanted the
    // hover lift, neither of which the primitive offered (DOR-1763 finding
    // 17.5). Both are axes now, so wanting one is no longer a reason to leave.
    variant: {
      /** Sits there. */
      static: '',
      /** Lifts on hover and on keyboard focus — a card you can press. */
      interactive: 'card-interactive',
    },
    radius: {
      md: 'rounded-lg',
      lg: 'rounded-xl',
    },
    /** Space between the card's own children, for cards that don't set their own. */
    gap: {
      none: 'gap-0',
      sm: 'gap-3',
      md: 'gap-4',
    },
  },
  defaultVariants: { variant: 'static', radius: 'md', gap: 'md' },
});

/** Everything a card draws — its shape, its spacing, and whether it responds. */
export interface CardProps extends React.ComponentProps<'div'>, VariantProps<typeof cardVariants> {}

/**
 * Surface container with border, padding, and soft elevation.
 *
 * @param variant - `static` (default), or `interactive` for the hover lift.
 * @param radius - `md` (default) or `lg` for the larger corner.
 * @param gap - Space between children: `md` (default), `sm`, or `none` when the body sets its own.
 */
function Card({ className, variant, radius, gap, ...props }: CardProps) {
  return (
    <div
      data-slot="card"
      className={cn(cardVariants({ variant, radius, gap }), className)}
      {...props}
    />
  );
}

/** Header cluster for a {@link Card} — title and description. */
function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="card-header" className={cn('flex flex-col gap-1', className)} {...props} />
  );
}

/** Card title — a styled label (not a semantic heading; use the `heading` node for those). */
function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-title"
      className={cn('text-sm leading-none font-semibold', className)}
      {...props}
    />
  );
}

/** Muted supporting copy beneath a {@link CardTitle}. */
function CardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="card-description"
      className={cn('text-muted-foreground text-xs', className)}
      {...props}
    />
  );
}

/** Primary body region of a {@link Card}. */
function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="card-content" className={cn('flex flex-col gap-3', className)} {...props} />
  );
}

/** Footer region of a {@link Card}, separated from the body. */
function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center gap-2 border-t pt-3', className)}
      {...props}
    />
  );
}

export { Card, cardVariants, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
