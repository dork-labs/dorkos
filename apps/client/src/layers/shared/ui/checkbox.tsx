'use client';

import * as React from 'react';
import { CheckIcon } from 'lucide-react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';

import { cn } from '@/layers/shared/lib/utils';

/**
 * A checkbox that answers a click the way its siblings do.
 *
 * It used to be the one control in the system with no state transition: the
 * fill jumped from empty to solid in a frame and the tick was pinned to
 * `transition-none`, while `Switch` — sitting in the same settings row —
 * animated both its track and its thumb. 100ms is the design system's
 * micro-interaction band, and it names "checkbox toggle" as the example
 * (DOR-1751). The tick still reads statically under reduced motion: the global
 * reset flattens the duration and leaves the end state alone.
 */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:bg-input/30 dark:aria-invalid:ring-destructive/40 dark:data-[state=checked]:bg-primary size-4 shrink-0 rounded-[4px] border shadow-xs transition-[color,background-color,border-color,box-shadow] duration-100 outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        // An entrance rather than a transition, because Radix mounts this node
        // only while the box is checked — there is no unchecked state sitting
        // here to transition FROM. `motion-safe:` for the same reason the badge
        // wake carries it: a tick that grew is no more informative than a tick
        // that is simply there.
        className="motion-safe:animate-in motion-safe:zoom-in-75 grid place-content-center text-current motion-safe:duration-100"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
