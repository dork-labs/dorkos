import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '@/layers/shared/lib/utils';
import { TOUCH_TARGET_RESPONSIVE_H, TOUCH_TARGET_RESPONSIVE_SIZE } from './touch-target';

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
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5',
        md: 'h-9 px-4 py-2 has-[>svg]:px-3',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-md': 'size-9',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
    },
  }
);

/**
 * The button's size steps: an ordinal scale, plus a square one for icon-only.
 *
 * `md` is the default, and the token literally named `default` is gone — it said
 * nothing about how big the button was, and left `<Switch size="md">` next to
 * `<Button size="default">` looking like two unrelated decisions (DOR-1761).
 * `icon` went the same way, to `icon-md`. The pixels are unchanged.
 */
export type ButtonSize =
  'xs' | 'sm' | 'md' | 'lg' | 'icon-xs' | 'icon-sm' | 'icon-md' | 'icon-lg';

// xs and icon-xs are intentionally small UI chrome — excluded from responsive scaling
const RESPONSIVE_SIZE_CLASSES: Partial<Record<ButtonSize, string>> = {
  // 44px below the `md` breakpoint, spelled once in `touch-target.ts` — read its
  // module doc for why the gate is viewport width rather than touch capability,
  // and why the two sizes that match it exactly compose from the constant while
  // the rest state their own numbers.
  sm: 'h-11 md:h-8',
  md: TOUCH_TARGET_RESPONSIVE_H,
  lg: 'h-12 md:h-10',
  'icon-sm': 'size-10 md:size-8',
  'icon-md': TOUCH_TARGET_RESPONSIVE_SIZE,
  'icon-lg': 'size-12 md:size-10',
};

/** Props for {@link Button}. */
export interface ButtonProps
  extends React.ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  /** Render the child element instead of a `<button>`, keeping the styling. */
  asChild?: boolean;
  /**
   * Grow to a 44px touch target below `md`, back to `size` past it.
   *
   * On by default. Turn it off for chrome that is not meant to be a thumb target
   * — a filter bar, a toolbar — where the taller box would crowd its neighbours.
   *
   * @default true
   */
  responsive?: boolean;
}

/**
 * The button — every clickable control in the app that is not a link.
 *
 * `variant` says what kind of action it is, `size` how big. Both default to the
 * middle of their scale, so `<Button>Save</Button>` is already right most of the
 * time. `asChild` hands the styling to your own element, which is how a router
 * link wears a button's clothes.
 */
function Button({
  className,
  variant = 'default',
  size = 'md',
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
      // A real `<button>` inside a `<form>` is a SUBMIT button unless it says
      // otherwise, so `<Button onClick={…}>Cancel</Button>` in a form used to
      // submit it — presenting as "the dialog closes when I click Cancel".
      // Nothing was broken when this landed; it is the next one that would have
      // been. `asChild` is left alone: the slotted child owns its own element,
      // and forcing a `type` onto an `<a>` is meaningless. It sits before the
      // spread, so the 15 call sites that mean `type="submit"` still win.
      {...(asChild ? {} : { type: props.type ?? 'button' })}
      className={cn(
        buttonVariants({ variant, size }),
        responsive ? RESPONSIVE_SIZE_CLASSES[size ?? 'md'] : undefined,
        className
      )}
      {...props}
    />
  );
}

export { Button, buttonVariants };
