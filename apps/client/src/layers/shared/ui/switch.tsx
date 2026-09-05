import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { tv, type VariantProps } from 'tailwind-variants';

/**
 * The four steps, each stating a track width and the travel that crosses it.
 *
 * Travel = track width − thumb width − 2×border, at every size. The two numbers
 * used to live in separate lookup tables — a `w-14` track beside a
 * `translate-x-7` thumb, four pairs kept equal by hand, and nothing that would
 * notice if one moved.
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

/**
 * The same four steps, climbing on smaller screens: two rungs up on a phone, one
 * on a tablet, the chosen size again from `md` on. `xl` is the top, so a size
 * near it simply stops climbing.
 *
 * **Written out rather than built.** Tailwind only ever sees class names that
 * appear literally in a source file, so a string this module assembles at
 * runtime — `'md:' + track` — is a class the generated CSS does not contain, and
 * the switch would silently keep its phone size on a desktop. The cost is a
 * second table, and `__tests__/switch.test.tsx` derives this one from
 * {@link SWITCH_TRACKS} and fails if the two ever disagree.
 */
const SWITCH_RESPONSIVE_TRACKS = {
  sm: {
    root: 'h-6 w-11 sm:h-5 sm:w-9 md:h-4 md:w-7',
    thumb:
      'h-5 w-5 data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0 sm:h-4 sm:w-4 sm:data-[state=checked]:translate-x-4 sm:data-[state=unchecked]:translate-x-0 md:h-3 md:w-3 md:data-[state=checked]:translate-x-3 md:data-[state=unchecked]:translate-x-0',
  },
  md: {
    root: 'h-8 w-14 sm:h-6 sm:w-11 md:h-5 md:w-9',
    thumb:
      'h-6 w-6 data-[state=checked]:translate-x-7 data-[state=unchecked]:translate-x-0 sm:h-5 sm:w-5 sm:data-[state=checked]:translate-x-5 sm:data-[state=unchecked]:translate-x-0 md:h-4 md:w-4 md:data-[state=checked]:translate-x-4 md:data-[state=unchecked]:translate-x-0',
  },
  lg: {
    root: 'h-8 w-14 sm:h-8 sm:w-14 md:h-6 md:w-11',
    thumb:
      'h-6 w-6 data-[state=checked]:translate-x-7 data-[state=unchecked]:translate-x-0 sm:h-6 sm:w-6 sm:data-[state=checked]:translate-x-7 sm:data-[state=unchecked]:translate-x-0 md:h-5 md:w-5 md:data-[state=checked]:translate-x-5 md:data-[state=unchecked]:translate-x-0',
  },
  xl: {
    root: 'h-8 w-14 sm:h-8 sm:w-14 md:h-8 md:w-14',
    thumb:
      'h-6 w-6 data-[state=checked]:translate-x-7 data-[state=unchecked]:translate-x-0 sm:h-6 sm:w-6 sm:data-[state=checked]:translate-x-7 sm:data-[state=unchecked]:translate-x-0 md:h-6 md:w-6 md:data-[state=checked]:translate-x-7 md:data-[state=unchecked]:translate-x-0',
  },
} as const;

/**
 * The track and the thumb, sized together.
 *
 * `tv` with slots rather than `cva` because this is the shape ADR-0097 adopted
 * it for: two DOM elements answering ONE axis, where the thumb's travel has to
 * stay in lockstep with the track's width.
 *
 * `responsive` is a second axis, not a branch, and it lands after `size` on
 * purpose: tailwind-merge lets its breakpoint heights replace the fixed ones
 * while everything else passes through untouched.
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

/** Props for {@link Switch}. */
export interface SwitchProps
  extends React.ComponentProps<typeof SwitchPrimitive.Root>, VariantProps<typeof switchVariants> {
  /**
   * Grow the switch on smaller screens — two size steps up on a phone, one on a
   * tablet, the chosen `size` from `md` on.
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
  const ladder = responsive ? SWITCH_RESPONSIVE_TRACKS[resolved] : undefined;

  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={root({ className: [ladder?.root, className] })}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={thumb({ className: ladder?.thumb })}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch, SWITCH_TRACKS, SWITCH_RESPONSIVE_TRACKS };
