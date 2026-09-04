import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { tv, type VariantProps } from 'tailwind-variants';

/**
 * The track and the thumb, sized together.
 *
 * `tv` with slots rather than `cva` because this is the shape ADR-0097 adopted
 * it for: two DOM elements answering ONE axis, where the thumb's travel has to
 * stay in lockstep with the track's width. Those two numbers used to live in
 * separate lookup tables — a `w-14` track beside a `translate-x-7` thumb, four
 * pairs kept equal by hand, and nothing that would notice if one moved.
 *
 * `responsive` is a second axis, not a branch. It is mobile-first — an iOS-sized
 * switch on a phone, medium on a tablet, the desktop default past `md` — and it
 * lands after `size` on purpose: tailwind-merge lets the responsive heights
 * replace the fixed ones while the breakpoint variants pass through untouched.
 */
export const switchVariants = tv({
  slots: {
    root: 'peer focus-visible:ring-ring focus-visible:ring-offset-background data-[state=checked]:bg-primary data-[state=unchecked]:bg-input inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
    thumb:
      'bg-background pointer-events-none block rounded-full shadow-lg ring-0 transition-transform',
  },
  variants: {
    // Each row states a track width and the travel that crosses it, so the two
    // cannot drift apart: travel = track width − thumb width − 2×border.
    size: {
      sm: {
        root: 'h-4 w-7',
        thumb: 'h-3 w-3 data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0',
      },
      default: {
        root: 'h-5 w-9',
        thumb: 'h-4 w-4 data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
      },
      md: {
        root: 'h-6 w-11',
        thumb: 'h-5 w-5 data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0',
      },
      lg: {
        root: 'h-8 w-14',
        thumb: 'h-6 w-6 data-[state=checked]:translate-x-7 data-[state=unchecked]:translate-x-0',
      },
    },
    responsive: {
      true: {
        root: 'h-8 w-14 sm:h-6 sm:w-11 md:h-5 md:w-9',
        thumb:
          'h-6 w-6 data-[state=checked]:translate-x-7 data-[state=unchecked]:translate-x-0 sm:h-5 sm:w-5 sm:data-[state=checked]:translate-x-5 md:h-4 md:w-4 md:data-[state=checked]:translate-x-4',
      },
      false: {},
    },
  },
  defaultVariants: {
    size: 'default',
    responsive: false,
  },
});

/**
 * The switch's size steps, derived from {@link switchVariants} rather than
 * stated a second time — the two used to drift silently the moment either
 * changed, since nothing tied this literal union to the variant table's own
 * `size` keys.
 */
export type SwitchSize = NonNullable<VariantProps<typeof switchVariants>['size']>;

export interface SwitchProps
  extends
    React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>,
    Omit<VariantProps<typeof switchVariants>, 'responsive'> {
  /**
   * When true and no explicit size is given, automatically scales up on smaller
   * screens for easier touch interaction (iOS-sized on mobile, medium on tablet).
   * @default true
   */
  responsive?: boolean;
}

const Switch = React.forwardRef<React.ComponentRef<typeof SwitchPrimitive.Root>, SwitchProps>(
  ({ className, size, responsive = true, ...props }, ref) => {
    // An explicit size is a decision, so it wins: `responsive` only fills in
    // when the caller has not said what size they want.
    const { root, thumb } = switchVariants({
      size: size ?? 'default',
      responsive: responsive && size === undefined,
    });

    return (
      <SwitchPrimitive.Root data-slot="switch" className={root({ className })} {...props} ref={ref}>
        <SwitchPrimitive.Thumb data-slot="switch-thumb" className={thumb()} />
      </SwitchPrimitive.Root>
    );
  }
);
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
