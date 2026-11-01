'use client';

import * as React from 'react';
import { CheckIcon } from 'lucide-react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';

import { cn } from './cn.js';
import { FOCUS_RING } from './focus-ring.js';

/** Props for {@link Checkbox}. */
export interface CheckboxProps extends React.ComponentProps<typeof CheckboxPrimitive.Root> {
  /**
   * Grow the box a step on smaller screens, back to 16px past `md`.
   *
   * On by default, matching `Switch`, `Input` and `Button` — a form whose text
   * fields grow on a phone while its checkboxes hold at 16px reads as unfinished.
   *
   * The box never draws at the full 44px touch target; at that size it would
   * dwarf the line of text beside it. Its hit area grows to 44 instead (24 past
   * `md`), and the label beside it ticks the box too.
   *
   * @default true
   */
  responsive?: boolean;
}

/**
 * A checkbox that answers a click the way its siblings do.
 *
 * It used to be the one control in the system with no state transition: the
 * fill jumped from empty to solid in a frame and the tick was pinned to
 * `transition-none`, while `Switch` — sitting in the same settings row —
 * animated both its track and its thumb (DOR-1751). The tick still reads
 * statically under reduced motion: the root transition is suppressed locally and
 * the indicator animation is motion-safe only.
 */
function Checkbox({ className, responsive = true, ...props }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer border-dui-control-edge hover:border-dui-control-edge-hover disabled:hover:border-dui-control-edge aria-invalid:border-dui-destructive data-[state=checked]:border-dui-primary data-[state=checked]:bg-dui-primary data-[state=checked]:text-dui-primary-foreground dui-dark:bg-dui-input/30 dui-dark:data-[state=checked]:bg-dui-primary relative shrink-0 rounded-[4px] border transition-[color,background-color,border-color] duration-150 after:absolute after:-inset-3 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none! md:after:-inset-1',
        FOCUS_RING,
        responsive ? 'size-5 md:size-4' : 'size-4',
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
