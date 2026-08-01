import * as React from 'react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';

import { cn } from '@/layers/shared/lib/utils';

/**
 * A row of two or more mutually exclusive choices, all visible at once.
 *
 * Built on Radix's radio group rather than hand-rolled, so it arrives with the
 * keyboard behaviour a person is entitled to expect: one Tab stop for the whole
 * row, arrow keys moving (and selecting) between segments, `role="radiogroup"`
 * and `aria-checked` without anyone remembering to write them.
 *
 * Use it when the options are few, short, and worth reading side by side — the
 * Trust Dial's three stops are the reference case. A list that has to scroll, or
 * options whose labels are sentences, wants a menu instead.
 *
 * @param props - Radix radio-group props; `value`, `onValueChange`, `disabled`.
 */
function SegmentedControl({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="segmented-control"
      orientation="horizontal"
      className={cn(
        'bg-muted border-border flex w-full items-stretch gap-0.5 rounded-lg border p-0.5',
        'data-[disabled]:opacity-50',
        className
      )}
      {...props}
    />
  );
}

/**
 * One segment. Renders its own children — an icon, a word, a second line — so the
 * primitive stays a shape and the meaning stays with the caller.
 *
 * The selected segment lifts: it takes the page's own background and a soft
 * shadow, which is what makes a flat row read as a switch. That change is the one
 * thing here that animates, and it stops animating under reduced motion.
 *
 * @param props - Radix radio-item props; `value` identifies the segment.
 */
function SegmentedControlItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="segmented-control-item"
      className={cn(
        // `flex-auto`, not `flex-1`: segments start at their content width and share
        // what is left, so a long word like "Full autonomy" is not squeezed into an
        // ellipsis by two short ones. The stop words are the control.
        'text-muted-foreground flex min-w-0 flex-auto cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs',
        'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
        'motion-safe:transition-[background-color,color,box-shadow] motion-safe:duration-150 motion-safe:ease-out',
        'hover:text-foreground data-[state=checked]:bg-background data-[state=checked]:text-foreground data-[state=checked]:shadow-soft',
        'disabled:pointer-events-none disabled:cursor-not-allowed',
        className
      )}
      {...props}
    >
      {children}
    </RadioGroupPrimitive.Item>
  );
}

export { SegmentedControl, SegmentedControlItem };
