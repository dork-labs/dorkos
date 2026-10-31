import * as React from 'react';
import { Check } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/layers/shared/lib/utils';

/**
 * A card is a surface and a soft lift, nothing else: no border. Height comes
 * from elevation, and in dark mode the soft lift paints the card 2% lighter
 * than the page, so its edge reads without a line (Phase 2, C1).
 *
 * A chosen card (a picker tile, a gallery pick) carries an outline in the ink
 * colour at offset 0, never a tint and never orange: an outline marks an
 * object, and orange is focus (C9). `aria-pressed`, `aria-checked` and
 * `data-selected` all say it, so a caller states the fact once, in ARIA.
 */
const cardVariants = cva(
  cn(
    'bg-card text-card-foreground shadow-soft relative flex flex-col',
    'aria-pressed:outline-foreground aria-pressed:outline-2 aria-pressed:outline-offset-0',
    'aria-checked:outline-foreground aria-checked:outline-2 aria-checked:outline-offset-0',
    'data-[selected=true]:outline-foreground data-[selected=true]:outline-2 data-[selected=true]:outline-offset-0'
  ),
  {
    variants: {
      // About ten files hand-wrote this shell rather than importing the component
      // — some because they wanted `rounded-xl`, some because they wanted the
      // hover lift, neither of which the primitive offered (DOR-1763 finding
      // 17.5). Both are axes now, so wanting one is no longer a reason to leave.
      variant: {
        /** Sits there. */
        static: '',
        /**
         * Lifts on hover and on keyboard focus — a card you can press. Focus is
         * the outer outline every control uses (B6), so it sits outside the
         * card's own selected outline rather than on top of it.
         */
        interactive:
          'card-interactive focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2',
      },
      radius: {
        md: 'rounded-lg',
        /** A hero tile at least 320px wide. Everything else is `md`. */
        lg: 'rounded-xl',
      },
      /**
       * The card's inset. 16px on desktop and on the phone alike, never less.
       * `none` is for a card whose body is rows: the rows pay the inset, edge to
       * edge, and the card's corners clip the first and last.
       */
      padding: {
        md: 'p-4',
        none: '',
      },
      /**
       * Space between the card's own children.
       *
       * `none` emits no gap utility at all rather than `gap-0`, so a body that
       * spaces itself — with its own margins, or a different gap on each axis —
       * is not fighting a class the card put there first.
       */
      gap: {
        none: '',
        sm: 'gap-3',
        md: 'gap-4',
      },
    },
    defaultVariants: { variant: 'static', radius: 'md', gap: 'md', padding: 'md' },
  }
);

/** Everything a card draws — its shape, its spacing, and whether it responds. */
export interface CardProps extends React.ComponentProps<'div'>, VariantProps<typeof cardVariants> {
  /**
   * Draws the chosen mark: the ink outline and a check, top right. Stamps
   * `data-selected` so the outline comes from the same rule ARIA would set.
   * A card that is itself a toggle should say `aria-pressed` instead and pass
   * this too, for the check.
   */
  selected?: boolean;
}

/**
 * Surface container with padding and soft elevation. No border.
 *
 * Never nest one in another, and never put one in a dialog, sheet or popover:
 * the inner one becomes a group (`FieldCard`) or plain space.
 *
 * @param variant - `static` (default), or `interactive` for the hover lift.
 * @param radius - `md` (default) or `lg` for a hero tile.
 * @param gap - Space between children: `md` (default), `sm`, or `none` when the body sets its own.
 * @param padding - `md` (default, 16px) or `none` when the body is rows.
 * @param selected - Draws the chosen outline and check.
 */
function Card({
  className,
  variant,
  radius,
  gap,
  padding,
  selected,
  children,
  ...props
}: CardProps) {
  return (
    <div
      data-slot="card"
      data-selected={selected || undefined}
      className={cn(cardVariants({ variant, radius, gap, padding }), className)}
      {...props}
    >
      {children}
      {selected && (
        <Check
          aria-hidden
          data-slot="card-selected-mark"
          className="text-foreground absolute top-2 right-2 size-4"
        />
      )}
    </div>
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
      // `leading-5`, not `leading-none`: a 1:1 line clipped descenders once the
      // phone's ramp took the size to 17px.
      className={cn('text-sm leading-5 font-semibold', className)}
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

/**
 * Footer region of a {@link Card}: its actions, right-aligned, one primary.
 * Separated from the body by space, never a rule.
 */
function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center justify-end gap-2 pt-1', className)}
      {...props}
    />
  );
}

export { Card, cardVariants, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
