import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from './cn.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip.js';
import {
  TOUCH_HIT_AREA,
  TOUCH_TARGET_RESPONSIVE_H,
  TOUCH_TARGET_RESPONSIVE_SIZE,
} from './touch-target.js';

const PRIMARY =
  'bg-dui-primary text-dui-primary-foreground hover:bg-dui-primary/90 aria-disabled:hover:bg-dui-primary';

// A tint of the foreground, not a fixed grey. A fixed fill vanishes on the sidebar,
// which is nearly the same grey, and a tint reads on every ground a button sits on.
const SECONDARY =
  'bg-dui-foreground/7 text-dui-foreground hover:bg-dui-foreground/11 aria-pressed:bg-dui-foreground/11 data-[state=on]:bg-dui-foreground/11 aria-disabled:hover:bg-dui-foreground/7';

// `[&_svg:not([class*='size-'])]:size-(--dui-size-icon-sm)` is the default size for
// any `<svg>` a caller drops in without sizing it. The TOKEN, not a flat
// `size-4`: the button's own height grows below 768px (RESPONSIVE_SIZE_CLASSES
// below), and an icon frozen at 16px inside a 44px target reads as a shrinking
// icon. `--dui-size-icon-sm` is 16px on desktop and 20px on a phone — the same
// proportion at both. The `:not([class*='size-'])` guard is the opt-out: any
// `size-*` class on the svg, token or literal, wins over this default.
const buttonVariants = cva(
  // **One focus ring for every variant: a solid outline, 2px out.** The gap is
  // transparent, so it works on any ground, where a `ring-offset` painted the page
  // colour onto a sidebar. An outline also survives forced-colours mode, which
  // drops box-shadows. There is deliberately no `outline-none` here: in Tailwind v4
  // it sets the outline style a later `outline-2` reads, so the ring would never
  // draw. The browser only paints its own outline on `:focus-visible` anyway.
  // `has-[:focus-visible]` is the same ring for a button that wraps its real
  // control: a file picker is a label around a hidden input, and keyboard focus
  // lands on the input, which nobody can see. An invalid button's ring is the
  // destructive colour.
  //
  // **The press lives here, not at the call site.** The design system asks every
  // button for "scale to 0.97 on active, spring back", and for a long time the
  // primitive answered a press with nothing — which is why fifteen hand-rolled
  // controls grew their own press and no two picked the same number (DOR-1751).
  // `motion-safe:` because a shrink that only ever reads as movement has no
  // static half worth keeping for a reader who asked for less of it. In over 80ms,
  // back over 120ms; a CSS transition can be interrupted mid-press.
  //
  // **The transition names its properties.** `transition-all` also animated the
  // `h-11 md:h-9` swap in `RESPONSIVE_SIZE_CLASSES`, so dragging a window
  // across 768px animated the height of every button on screen. `scale` is
  // named as itself: Tailwind v4's scale utilities write the standalone `scale`
  // property, so a list saying `transform` would transition nothing. The three
  // durations and curves line up with the three properties, in order.
  //
  // **`aria-disabled` keeps the pointer.** Loading and `disabledReason` stay
  // focusable, and a reason's tooltip needs the hover, so neither can use
  // `pointer-events-none` the way a natively disabled button does.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,scale] [transition-duration:var(--dui-dur-fast),var(--dui-dur-fast),var(--dui-dur-answer)] [transition-timing-function:var(--dui-ease-standard),var(--dui-ease-standard),var(--dui-ease-out)] motion-safe:active:scale-[0.97] motion-safe:active:[transition-duration:var(--dui-dur-fast),var(--dui-dur-fast),var(--dui-dur-press)] disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-default not-aria-busy:aria-disabled:opacity-50 motion-safe:aria-disabled:active:scale-100 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-(--dui-size-icon-sm) shrink-0 [&_svg]:shrink-0 outline-dui-ring focus-visible:outline-2 focus-visible:outline-offset-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 aria-invalid:outline-dui-destructive",
  {
    variants: {
      variant: {
        primary: PRIMARY,
        secondary: SECONDARY,
        /** @deprecated Use `primary`. */
        default: PRIMARY,
        /** @deprecated Use `secondary`. */
        outline: SECONDARY,
        destructive:
          'bg-dui-destructive-fill text-dui-destructive-foreground hover:bg-dui-destructive-fill-hover aria-disabled:hover:bg-dui-destructive-fill',
        ghost:
          'text-dui-foreground hover:bg-dui-foreground/7 aria-pressed:bg-dui-foreground/11 data-[state=on]:bg-dui-foreground/11 aria-disabled:hover:bg-transparent',
        brand:
          'bg-dui-brand text-dui-brand-foreground hover:bg-dui-brand/90 aria-disabled:hover:bg-dui-brand',
        link: 'text-current underline decoration-current/35 underline-offset-3 hover:decoration-current aria-disabled:hover:decoration-current/35',
      },
      size: {
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-(--dui-size-icon-xs)",
        sm: 'h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5',
        md: 'h-9 px-4 py-2 has-[>svg]:px-3',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-(--dui-size-icon-xs)",
        'icon-sm': 'size-8',
        'icon-md': 'size-9',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  }
);

/** The names that are on their way out, and the name each one now means. */
const VARIANT_ALIASES = { default: 'primary', outline: 'secondary' } as const;

/**
 * The button's size steps: an ordinal scale, plus a square one for icon-only.
 *
 * `md` is the default, and the token literally named `default` is gone — it said
 * nothing about how big the button was, and left `<Switch size="md">` next to
 * `<Button size="default">` looking like two unrelated decisions (DOR-1761).
 * `icon` went the same way, to `icon-md`. The pixels are unchanged.
 */
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon-xs' | 'icon-sm' | 'icon-md' | 'icon-lg';

const RESPONSIVE_SIZE_CLASSES: Record<ButtonSize, string> = {
  // 44px below the `md` breakpoint, spelled once in `touch-target.ts` — read its
  // module doc for why the gate is viewport width rather than touch capability,
  // and why the two sizes that match it exactly compose from the constant while
  // the rest state their own numbers. Every size clears 44, the small ones included:
  // a thumb is the same size whatever the button looks like on a desktop.
  xs: 'h-11 md:h-6',
  sm: 'h-11 md:h-8',
  md: TOUCH_TARGET_RESPONSIVE_H,
  lg: 'h-12 md:h-10',
  'icon-xs': 'size-11 md:size-6',
  'icon-sm': 'size-11 md:size-8',
  'icon-md': TOUCH_TARGET_RESPONSIVE_SIZE,
  'icon-lg': 'size-12 md:size-10',
};

/** The busy state's two props, which only come together. */
type ButtonLoadingProps =
  | {
      /** Show the busy state: the label swaps, the width holds and clicks do nothing. */
      loading: boolean;
      /** What the button says while busy, as a gerund: Save becomes "Saving…". */
      loadingLabel: string;
    }
  | { loading?: undefined; loadingLabel?: undefined };

/** Props for {@link Button}. */
export type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> &
  ButtonLoadingProps & {
    /** Render the child element instead of a `<button>`, keeping the styling. */
    asChild?: boolean;
    /**
     * Grow to a 44px touch target below `md`, back to `size` past it.
     *
     * On by default. Turn it off for chrome that is not meant to be a thumb target
     * — a filter bar, a toolbar — where the taller box would crowd its neighbours.
     * The box then keeps its size and gains an invisible 44px hit area.
     *
     * @default true
     */
    responsive?: boolean;
    /**
     * Why this can't be pressed right now. Disables the button, keeps it focusable
     * and shows the reason in a tooltip, because a greyed button with no reason is
     * a locked door with no sign.
     */
    disabledReason?: string;
  };

/**
 * Split a button's children into a leading icon and the label after it.
 *
 * Only the label swaps while busy, so the icon stays put. With no bare text to
 * split on, the last child is taken as the label.
 */
function splitLeading(children: React.ReactNode) {
  const nodes = React.Children.toArray(children);
  const firstText = nodes.findIndex((n) => typeof n === 'string' || typeof n === 'number');
  const at = firstText === -1 ? nodes.length - 1 : firstText;
  return { leading: nodes.slice(0, at), label: nodes.slice(at) };
}

/**
 * Both labels in one grid cell, the idle one hidden while busy.
 *
 * The box is always as wide as the wider of the two, so the button never shifts.
 */
function StableLabel({
  children,
  loading,
  loadingLabel,
}: {
  children: React.ReactNode;
  loading: boolean;
  loadingLabel: string;
}) {
  const { leading, label } = splitLeading(children);
  return (
    <>
      {leading}
      <span className="grid justify-items-center *:[grid-area:1/1]">
        <span className={loading ? 'invisible' : undefined}>{label}</span>
        <span className={loading ? undefined : 'invisible'}>{loadingLabel}</span>
      </span>
    </>
  );
}

function swallowClick(event: React.MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
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
  variant = 'primary',
  size = 'md',
  asChild = false,
  responsive = true,
  loading = false,
  loadingLabel,
  disabledReason,
  disabled,
  onClick,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  const resolvedVariant = VARIANT_ALIASES[variant as keyof typeof VARIANT_ALIASES] ?? variant;
  const resolvedSize = size ?? 'md';
  const iconOnly = resolvedSize.startsWith('icon');
  // `aria-disabled`, not `disabled`: a native disabled button drops focus to the
  // body the moment a save starts, and cannot be focused to read its reason.
  const blocked = loading || Boolean(disabledReason);

  const button = (
    <Comp
      data-slot="button"
      data-variant={resolvedVariant}
      data-size={resolvedSize}
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
        responsive ? RESPONSIVE_SIZE_CLASSES[resolvedSize] : TOUCH_HIT_AREA,
        loading &&
          iconOnly &&
          '[&_svg]:motion-safe:animate-dui-breathe [&_svg]:motion-reduce:opacity-50',
        className
      )}
      {...props}
      disabled={blocked ? undefined : disabled}
      onClick={blocked ? swallowClick : onClick}
      {...(blocked && { 'aria-disabled': true })}
      {...(loading && { 'aria-busy': true })}
      {...(loading && iconOnly && { 'aria-label': loadingLabel })}
    >
      {loadingLabel === undefined || asChild || iconOnly ? (
        children
      ) : (
        <StableLabel loading={loading} loadingLabel={loadingLabel}>
          {children}
        </StableLabel>
      )}
    </Comp>
  );

  if (!disabledReason) return button;
  return (
    // Its own provider, so a consumer with no app-level one still gets the reason.
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>{disabledReason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export { Button, buttonVariants };
