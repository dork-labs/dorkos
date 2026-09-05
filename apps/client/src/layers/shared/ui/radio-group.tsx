import * as React from 'react';
import { CircleIcon } from 'lucide-react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';

import { cn } from '@/layers/shared/lib/utils';

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
      className={cn('grid gap-3', className)}
      {...props}
    />
  );
}

/** Props for {@link RadioGroupItem}. */
export interface RadioGroupItemProps
  extends React.ComponentProps<typeof RadioGroupPrimitive.Item> {
  /**
   * Grow the dot a step on smaller screens, back to 16px past `md`.
   *
   * On by default, matching `Checkbox` and `Switch`. Like them, it never reaches
   * the full 44px touch target — the label beside it is the thumb-sized target,
   * and clicking that picks the option.
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
        'border-input text-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:ring-destructive/40 aspect-square shrink-0 rounded-full border shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
        responsive ? 'size-5 md:size-4' : 'size-4',
        className
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="relative flex items-center justify-center"
      >
        <CircleIcon className="fill-primary absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };
