import * as React from 'react';
import { HoverCard as HoverCardPrimitive } from 'radix-ui';

import { cn } from './cn.js';
import { usePortalContainer } from './ui-provider.js';

/**
 * A card that appears when the pointer rests on something.
 *
 * For extra detail a reader may want and can ignore — never for anything they
 * have to act on, since a hover has no touch equivalent. `opts` on the root set
 * how long the pointer must rest before it opens.
 */
function HoverCard({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />;
}

/**
 * The thing being hovered. Pass `asChild` to use your own element.
 *
 * A caller can take a `ref` to reach the trigger's own DOM node:
 * `IdentityHoverCard` needs it to restore focus to the TRIGGER (a mention pill,
 * an avatar) rather than to its footer's transient "View profile" button, which
 * is gone by the time anything downstream could ask for it back (DOR-1274
 * adversarial review). React 19 passes `ref` through props, so the spread below
 * is all that takes.
 */
function HoverCardTrigger({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />;
}

/** The card itself, portalled into the provider host or document body. */
function HoverCardContent({
  className,
  align = 'center',
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  const container = usePortalContainer();
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal" container={container}>
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'bg-dui-popover text-dui-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 border-dui-border z-50 w-64 origin-(--radix-hover-card-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden motion-reduce:animate-none!',
          className
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
