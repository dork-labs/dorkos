import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '../lib/utils';

export type SwitchSize = 'sm' | 'default' | 'md' | 'lg';

const TRACK_BASE =
  'peer focus-visible:ring-ring focus-visible:ring-offset-background data-[state=checked]:bg-primary data-[state=unchecked]:bg-input inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50';

const THUMB_BASE =
  'bg-background pointer-events-none block rounded-full shadow-lg ring-0 transition-transform';

const TRACK_SIZES: Record<SwitchSize, string> = {
  sm: 'h-4 w-7',
  default: 'h-5 w-9',
  md: 'h-6 w-11',
  lg: 'h-8 w-14',
};

const THUMB_SIZES: Record<SwitchSize, string> = {
  sm: 'h-3 w-3 data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0',
  default: 'h-4 w-4 data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
  md: 'h-5 w-5 data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0',
  lg: 'h-6 w-6 data-[state=checked]:translate-x-7 data-[state=unchecked]:translate-x-0',
};

// Mobile-first: iOS-sized on mobile, medium on tablet (sm:), default on desktop (md:)
const RESPONSIVE_TRACK = 'h-8 w-14 sm:h-6 sm:w-11 md:h-5 md:w-9';
const RESPONSIVE_THUMB =
  'h-6 w-6 data-[state=checked]:translate-x-7 data-[state=unchecked]:translate-x-0 ' +
  'sm:h-5 sm:w-5 sm:data-[state=checked]:translate-x-5 ' +
  'md:h-4 md:w-4 md:data-[state=checked]:translate-x-4';

export interface SwitchProps extends React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {
  size?: SwitchSize;
  /**
   * When true and no explicit size is given, automatically scales up on smaller
   * screens for easier touch interaction (iOS-sized on mobile, medium on tablet).
   * @default true
   */
  responsive?: boolean;
}

const Switch = React.forwardRef<React.ComponentRef<typeof SwitchPrimitive.Root>, SwitchProps>(
  ({ className, size, responsive = true, ...props }, ref) => {
    const isResponsive = responsive && size === undefined;
    const resolvedSize = size ?? 'default';

    return (
      <SwitchPrimitive.Root
        className={cn(
          TRACK_BASE,
          isResponsive ? RESPONSIVE_TRACK : TRACK_SIZES[resolvedSize],
          className
        )}
        {...props}
        ref={ref}
      >
        <SwitchPrimitive.Thumb
          className={cn(THUMB_BASE, isResponsive ? RESPONSIVE_THUMB : THUMB_SIZES[resolvedSize])}
        />
      </SwitchPrimitive.Root>
    );
  }
);
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
