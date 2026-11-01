/**
 * The dropdown for picking one option out of a list.
 *
 * A control, not a menu: it holds a value and shows it. Reach for
 * `DropdownMenu` when the entries are actions rather than a choice.
 *
 * Both the trigger and the items spend the full 44px touch target below `md`,
 * and both back off past it — see the `responsive` prop on each.
 *
 * @module @dork-labs/ui/select
 */
import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from './cn.js';
import { FIELD_CONTROL } from './field-control.js';
import { usePortalContainer } from './ui-provider.js';
import { TOUCH_TARGET_RESPONSIVE_H } from './touch-target.js';

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
export interface SelectTriggerProps extends React.ComponentProps<typeof SelectPrimitive.Trigger> {
  /**
   * `default` is 36px past `md` and 44px below it. `compact` is for a filter bar
   * or a toolbar: 32px past `md`, 40px below it with a hit area grown to 44.
   *
   * @default 'default'
   */
  density?: 'default' | 'compact';
  /**
   * @deprecated Use `density="compact"`. `false` holds 36px on a phone, under the
   * touch floor; it goes once its last callers have moved.
   */
  responsive?: boolean;
}

/** The closed control: the chosen value, and the chevron that opens the list. */
function SelectTrigger({
  className,
  children,
  density = 'default',
  responsive = true,
  ...props
}: SelectTriggerProps) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-density={density}
      className={cn(
        FIELD_CONTROL,
        'data-[placeholder]:text-dui-muted-foreground data-[state=open]:border-dui-control-edge-hover flex items-center justify-between py-2 whitespace-nowrap [&>span]:line-clamp-1',
        density === 'compact'
          ? 'relative h-10 after:absolute after:inset-x-0 after:-inset-y-0.5 md:h-8 md:after:hidden'
          : responsive
            ? TOUCH_TARGET_RESPONSIVE_H
            : 'h-9',
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="text-dui-muted-foreground size-(--dui-size-icon-sm) shrink-0" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/** The list panel, portalled into the provider host or document body. */
function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  const portalContainer = usePortalContainer();
  return (
    <SelectPrimitive.Portal container={portalContainer}>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          'bg-dui-popover text-dui-popover-foreground data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 dui-dark:border dui-dark:border-dui-border relative z-(--z-overlay) max-h-96 min-w-[8rem] overflow-hidden rounded-md shadow-lg',
          // OPENS WITH AN ANIMATION, CLOSES AT ONCE — the same load-bearing
          // half `dropdown-menu` carries, for the same reason and on the same
          // evidence (DOR-1835, following DOR-1834). Radix keeps this list
          // mounted for as long as it has a closing animation to play, and the
          // part of it that listens for "somebody pressed outside me" is kept
          // with it. This control's own button answers a press the instant the
          // pointer goes down — earlier than a plain click — so for the ~150ms
          // a fade lasted that one press was answered twice: the button
          // reopened the list, and the copy still finishing its fade read the
          // same press as a press outside and closed what had just opened.
          // Measured in a browser: the press landed 1.4ms after the list went
          // to its closing state, and the list was gone 160ms later having
          // never reopened.
          //
          // Restoring the fade needs Radix to be able to reopen a list it is
          // still closing, and it cannot: the reopened list is the SAME element
          // rather than a new one, so nothing puts the keyboard back inside it
          // and the arrow keys reach nothing. Leaving at once is what makes the
          // next press a clean start. Anyone who asked their machine to reduce
          // motion has had this behaviour all along.
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 motion-reduce:animate-none!',
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
        'focus:bg-dui-accent focus:text-dui-accent-foreground relative flex w-full cursor-default items-center rounded-sm pr-8 pl-2 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
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
