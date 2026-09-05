/**
 * The dropdown for picking one option out of a list.
 *
 * A control, not a menu: it holds a value and shows it. Reach for
 * `DropdownMenu` when the entries are actions rather than a choice.
 *
 * Both the trigger and the items spend the full 44px touch target below `md`,
 * and both back off past it — see the `responsive` prop on each.
 *
 * @module shared/ui/select
 */
import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from '@/layers/shared/lib/utils';
import { TOUCH_TARGET_RESPONSIVE_H } from './touch-target';

/** The select itself — wraps the trigger and the list, and owns the value. */
function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

/** A run of related options, kept together for keyboard navigation. */
function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

/**
 * The chosen option's text, shown inside the trigger.
 *
 * Give it a `placeholder` for the empty state — it is the only place that string
 * can live, since the trigger has no value of its own to show.
 */
function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

/** Props for {@link SelectTrigger}. */
export interface SelectTriggerProps
  extends React.ComponentProps<typeof SelectPrimitive.Trigger> {
  /**
   * Grow to a 44px touch target below `md`, back to 36px past it.
   *
   * On by default. Turn it off for chrome that is not meant to be a thumb
   * target — a filter bar, a toolbar — where the taller box would crowd
   * everything beside it.
   *
   * @default true
   */
  responsive?: boolean;
}

/** The closed control: the chosen value, and the chevron that opens the list. */
function SelectTrigger({ className, children, responsive = true, ...props }: SelectTriggerProps) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        'border-input ring-offset-background placeholder:text-muted-foreground focus:ring-ring aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex w-full items-center justify-between rounded-md border bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-sm focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1',
        responsive ? TOUCH_TARGET_RESPONSIVE_H : 'h-9',
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="h-4 w-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/** The list panel, portalled out so no `overflow: hidden` can clip it. */
function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border shadow-md',
          position === 'popper' &&
            'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
          className
        )}
        position={position}
        {...props}
      >
        <SelectPrimitive.Viewport
          className={cn(
            'p-1',
            position === 'popper' &&
              'h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]'
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

/** Props for {@link SelectItem}. */
export interface SelectItemProps extends React.ComponentProps<typeof SelectPrimitive.Item> {
  /**
   * Grow to a 44px touch target below `md`, back to the compact row past it.
   *
   * The same decision {@link SelectTriggerProps.responsive} makes, spent as
   * padding rather than height because a row's height follows its text. Keep the
   * two in step: a compact trigger with roomy items reads as a bug.
   *
   * @default true
   */
  responsive?: boolean;
}

/** One option in the list, ticked on the right when it is the chosen one. */
function SelectItem({ className, children, responsive = true, ...props }: SelectItemProps) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'focus:bg-accent focus:text-accent-foreground relative flex w-full cursor-default items-center rounded-sm pr-8 pl-2 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        responsive ? 'py-3 md:py-1.5' : 'py-1.5',
        className
      )}
      {...props}
    >
      <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectItem };
