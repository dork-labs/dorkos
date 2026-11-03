import * as React from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

import { cn } from './cn.js';
import { usePortalContainer } from './ui-provider.js';
import { useCanHover } from './use-can-hover.js';

/**
 * Context provider that configures tooltip delay and behavior.
 *
 * Waits 400ms, so a pointer crossing a toolbar doesn't flicker every label on the
 * way. Once one is showing, the next opens at once for 300ms.
 */
function TooltipProvider({
  delayDuration = 400,
  skipDelayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

/** Props for {@link Tooltip}. */
export interface TooltipProps extends React.ComponentProps<typeof TooltipPrimitive.Root> {
  /**
   * Keep this tooltip on a device with no hover. Only for words with no other home:
   * a disabled button's reason. Everywhere else a touch screen gets none, because a
   * tap would open it and leave it stuck, and the control's `aria-label` names it.
   */
  showOnTouch?: boolean;
}

/** Accessible tooltip root that manages hover and focus state. Shows nothing on touch. */
function Tooltip({ showOnTouch = false, open, ...props }: TooltipProps) {
  const canHover = useCanHover();
  return (
    <TooltipPrimitive.Root
      data-slot="tooltip"
      open={canHover || showOnTouch ? open : false}
      {...props}
    />
  );
}

/** Element that activates the tooltip on hover or focus. */
function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

/** Animated floating label displayed when the tooltip trigger is active. */
function TooltipContent({
  className,
  sideOffset = 6,
  collisionPadding = 8,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const container = usePortalContainer();
  return (
    <TooltipPrimitive.Portal container={container}>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          // `animate-in` with no state: a tooltip opens as `delayed-open` or
          // `instant-open`, never `open`.
          'animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 duration-(--dui-dur-fast) ease-(--dui-ease-out) motion-reduce:animate-none!',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-(--dui-dur-instant) data-[state=closed]:ease-(--dui-ease-in)',
          'bg-dui-tooltip text-dui-tooltip-foreground z-(--z-tooltip) w-fit max-w-64 origin-(--radix-tooltip-content-transform-origin) rounded-md px-2 py-1 text-xs text-balance',
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
