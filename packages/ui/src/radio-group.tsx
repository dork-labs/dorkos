import * as React from 'react';
import { CircleIcon } from 'lucide-react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';

import { cn } from './cn.js';
import { FOCUS_RING } from './focus-ring.js';

/**
 * A set of choices where exactly one can be picked.
 *
 * Wraps the {@link RadioGroupItem}s and owns the selected value; arrow keys move
 * between the items, which is why they are one group and not loose inputs.
 */
function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn('grid gap-3 max-md:gap-4', className)}
      {...props}
    />
  );
}

/** Props for {@link RadioGroupItem}. */
export interface RadioGroupItemProps extends React.ComponentProps<typeof RadioGroupPrimitive.Item> {
  /**
   * Grow the dot a step on smaller screens, back to 16px past `md`.
   *
   * On by default, matching `Checkbox` and `Switch`. Like them, it never draws at
   * the full 44px touch target. Its hit area grows to 44 instead (24 past `md`),
   * and the label beside it picks the option too.
   *
   * @default true
   */
  responsive?: boolean;
}

/**
 * One choice inside a {@link RadioGroup} — the dot the reader actually clicks.
 *
 * Pair it with a `Label` rather than putting the words inside it: the label is
 * what gives the 16px dot a full-width target to be clicked through.
 */
function RadioGroupItem({ className, responsive = true, ...props }: RadioGroupItemProps) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        'border-dui-control-edge hover:border-dui-control-edge-hover disabled:hover:border-dui-control-edge aria-invalid:border-dui-destructive text-dui-primary dui-dark:bg-dui-input/30 relative aspect-square shrink-0 rounded-full border transition-[color,background-color,border-color] duration-150 after:absolute after:-inset-3 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none! md:after:-inset-1',
        FOCUS_RING,
        responsive ? 'size-5 md:size-4' : 'size-4',
        className
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="relative flex items-center justify-center"
      >
        <CircleIcon className="fill-dui-primary absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };
