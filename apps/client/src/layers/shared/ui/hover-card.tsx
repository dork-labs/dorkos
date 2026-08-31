import * as React from 'react';
import { HoverCard as HoverCardPrimitive } from 'radix-ui';

import { cn } from '../lib/utils';

/** Accessible card that appears on hover over a trigger element. */
function HoverCard({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />;
}

/**
 * Element that activates the hover card on pointer hover.
 *
 * Forwards its ref — unlike this file's other wrappers — so a caller can
 * reach the trigger's own DOM node directly. `IdentityHoverCard` needs it to
 * restore focus to the TRIGGER (a mention pill, an avatar) rather than to its
 * footer's transient "View profile" button, which is gone by the time
 * anything downstream could ask for it back (DOR-1274 adversarial review).
 */
const HoverCardTrigger = React.forwardRef<
  React.ElementRef<typeof HoverCardPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Trigger>
>(({ ...props }, ref) => (
  <HoverCardPrimitive.Trigger ref={ref} data-slot="hover-card-trigger" {...props} />
));
HoverCardTrigger.displayName = HoverCardPrimitive.Trigger.displayName;

/** Animated popover content displayed when the hover card trigger is hovered. */
function HoverCardContent({
  className,
  align = 'center',
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal">
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-64 origin-(--radix-hover-card-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden',
          className
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
