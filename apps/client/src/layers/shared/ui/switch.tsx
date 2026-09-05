import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { tv, type VariantProps } from 'tailwind-variants';

/**
 * The four steps, each stating a track width and the travel that crosses it.
 *
 * One table, read twice — by {@link switchVariants} as its `size` variants, and
 * by the `responsive` ladder below as "one step up from here". Written out
 * separately so those two can never disagree about what `lg` is.
 *
 * Travel = track width − thumb width − 2×border, at every size.
 *
 * The names are the library-wide ordinal scale with `md` as the default, so
 * `<Switch size="md">` and `<Button size="md">` are the same claim. They used to
 * read `sm · default · md · lg`, where `md` was one step ABOVE the default and
 * lined up with nothing (DOR-1761). The pixels are unchanged.
 */
const SWITCH_TRACKS = {
  sm: {
    root: 'h-4 w-7',
    thumb: 'h-3 w-3 data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0',
  },
  md: {
    root: 'h-5 w-9',
    thumb: 'h-4 w-4 data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
  },
  lg: {
    root: 'h-6 w-11',
    thumb: 'h-5 w-5 data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0',
  },
  xl: {
    root: 'h-8 w-14',
    thumb: 'h-6 w-6 data-[state=checked]:translate-x-7 data-[state=unchecked]:translate-x-0',
  },
} as const;

/** The size steps in order, smallest first — the ladder `responsive` climbs. */
const SWITCH_SIZE_ORDER = ['sm', 'md', 'lg', 'xl'] as const;

/**
 * The track and the thumb, sized together.
 *
 * `tv` with slots rather than `cva` because this is the shape ADR-0097 adopted
 * it for: two DOM elements answering ONE axis, where the thumb's travel has to
 * stay in lockstep with the track's width. Those two numbers used to live in
 * separate lookup tables — a `w-14` track beside a `translate-x-7` thumb, four
 * pairs kept equal by hand, and nothing that would notice if one moved.
 */
export const switchVariants = tv({
  slots: {
    root: 'peer focus-visible:ring-ring focus-visible:ring-offset-background data-[state=checked]:bg-primary data-[state=unchecked]:bg-input inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
    thumb:
      'bg-background pointer-events-none block rounded-full shadow-lg ring-0 transition-transform',
  },
  variants: { size: SWITCH_TRACKS },
  defaultVariants: { size: 'md' },
});

/**
 * The switch's size steps, derived from {@link switchVariants} rather than
 * stated a second time — the two used to drift silently the moment either
 * changed, since nothing tied this literal union to the variant table's own
 * `size` keys.
 */
export type SwitchSize = NonNullable<VariantProps<typeof switchVariants>['size']>;

/**
 * The size `steps` rungs above this one, stopping at the top of the ladder.
 *
 * @param size - Where the caller put the switch.
 * @param steps - How many rungs to climb.
 */
function stepUp(size: SwitchSize, steps: number): SwitchSize {
  const index = SWITCH_SIZE_ORDER.indexOf(size);
  return SWITCH_SIZE_ORDER[Math.min(index + steps, SWITCH_SIZE_ORDER.length - 1)];
}

/**
 * The same classes, each behind a breakpoint prefix.
 *
 * @param prefix - A Tailwind breakpoint, `sm` or `md`.
 * @param classes - A space-separated class string from {@link SWITCH_TRACKS}.
 */
function at(prefix: 'sm' | 'md', classes: string): string {
  return classes
    .split(' ')
    .map((className) => `${prefix}:${className}`)
    .join(' ');
}

/**
 * The mobile-first ladder for one slot: two steps up on a phone, one on a
 * tablet, the chosen size from `md` on.
 *
 * @param size - The size the caller asked for.
 * @param slot - Which half of the switch to build the ladder for.
 */
function responsiveLadder(size: SwitchSize, slot: 'root' | 'thumb'): string {
  return [
    SWITCH_TRACKS[stepUp(size, 2)][slot],
    at('sm', SWITCH_TRACKS[stepUp(size, 1)][slot]),
    at('md', SWITCH_TRACKS[size][slot]),
  ].join(' ');
}

/** Props for {@link Switch}. */
export interface SwitchProps
  extends React.ComponentProps<typeof SwitchPrimitive.Root>, VariantProps<typeof switchVariants> {
  /**
   * Grow the switch on smaller screens — iOS-sized on a phone, one step down on
   * a tablet, the chosen `size` from `md` on.
   *
   * On by default, and it composes with `size` rather than replacing it, which
   * is what the prop means on `Button`, `Input`, `SelectTrigger` and `TabsList`
   * too. It used to be ignored whenever a size was given, so
   * `<Switch size="sm" responsive />` silently did nothing (DOR-1761).
   *
   * A switch never reaches the full 44px touch target — at that height it would
   * dwarf the row it sits in. The label beside it is the thumb-sized target, and
   * clicking that flips the switch.
   *
   * @default true
   */
  responsive?: boolean;
}

/**
 * The on/off control — a track the thumb slides across.
 *
 * Takes effect the moment it is flipped, so use it only where there is no Save
 * to press. When the change needs confirming, use a `Checkbox` in a form.
 */
function Switch({ className, size = 'md', responsive = true, ...props }: SwitchProps) {
  const resolved = size ?? 'md';
  const { root, thumb } = switchVariants({ size: resolved });

  // The ladder lands after the fixed size on purpose: tailwind-merge lets the
  // breakpoint classes replace the base ones rather than fight them.
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={root({
        className: [responsive && responsiveLadder(resolved, 'root'), className],
      })}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={thumb({ className: responsive && responsiveLadder(resolved, 'thumb') })}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
