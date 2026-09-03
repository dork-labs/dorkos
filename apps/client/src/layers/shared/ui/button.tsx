import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '@/layers/shared/lib/utils';

// `[&_svg:not([class*='size-'])]:size-(--size-icon-sm)` is the default size for
// any `<svg>` a caller drops in without sizing it. The TOKEN, not a flat
// `size-4`: the button's own height grows below 768px (RESPONSIVE_SIZE_CLASSES
// below), and an icon frozen at 16px inside a 44px target reads as a shrinking
// icon. `--size-icon-sm` is 16px on desktop and 20px on a phone — the same
// proportion at both. The `:not([class*='size-'])` guard is the opt-out: any
// `size-*` class on the svg, token or literal, wins over this default.
const buttonVariants = cva(
  // **The press lives here, not at the call site.** The design system asks every
  // button for "scale to 0.97 on active, spring back", and for a long time the
  // primitive answered a press with nothing — which is why fifteen hand-rolled
  // controls grew their own press and no two picked the same number (DOR-1751).
  // `motion-safe:` because a shrink that only ever reads as movement has no
  // static half worth keeping for a reader who asked for less of it.
  //
  // **The transition names its properties.** `transition-all` also animated the
  // `h-11 md:h-9` swap in `RESPONSIVE_SIZE_CLASSES`, so dragging a window
  // across 768px animated the height of every button on screen. `scale` is
  // named as itself: Tailwind v4's scale utilities write the standalone `scale`
  // property, so a list saying `transform` would transition nothing.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,box-shadow,scale] duration-150 motion-safe:active:scale-[0.97] motion-safe:active:duration-100 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-(--size-icon-sm) shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        brand:
          'bg-brand text-brand-foreground hover:bg-brand/90 focus-visible:ring-brand/20 dark:focus-visible:ring-brand/40',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export type ButtonSize =
  'xs' | 'sm' | 'default' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg';

// xs and icon-xs are intentionally small UI chrome — excluded from responsive scaling
const RESPONSIVE_SIZE_CLASSES: Partial<Record<ButtonSize, string>> = {
  // 44px below the `md` breakpoint (Apple HIG / Material minimum), not 40px
  // — DOR-771. This gate is VIEWPORT WIDTH (Tailwind's `md:`, 768px), not a
  // touch-capability media query, so it is really "narrow screens get more
  // headroom", not "touch screens do" — a resized desktop window under 768px
  // gets the taller target too, and a touch device above it does not. Kept
  // 32px past `md:` on purpose: the width is a proxy for finger-sized targets
  // mattering more, not a claim about the actual input device.
  sm: 'h-11 md:h-8',
  default: 'h-11 md:h-9',
  lg: 'h-12 md:h-10',
  icon: 'size-11 md:size-9',
  'icon-sm': 'size-10 md:size-8',
  'icon-lg': 'size-12 md:size-10',
};

export interface ButtonProps
  extends React.ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  responsive?: boolean;
}

/** Styled button with variant, size, and responsive scaling support. */
function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  responsive = true,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(
        buttonVariants({ variant, size }),
        responsive ? RESPONSIVE_SIZE_CLASSES[size ?? 'default'] : undefined,
        className
      )}
      {...props}
    />
  );
}

export { Button, buttonVariants };
