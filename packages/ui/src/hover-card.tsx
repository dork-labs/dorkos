import * as React from 'react';
import { HoverCard as HoverCardPrimitive } from 'radix-ui';

import { cn } from './cn.js';
import { ENTER_FAST, EXIT_FAST, FLOATING_SURFACE } from './menu-item.js';
import { usePortalContainer } from './ui-provider.js';

/**
 * A card that appears when the pointer rests on something.
 *
 * For extra detail a reader may want and can ignore — never for anything they
 * have to act on, since a hover has no touch equivalent. It waits 500ms for the
 * pointer to rest and 150ms after it leaves; `openDelay` and `closeDelay` change that.
 */
function HoverCard({
  openDelay = 500,
  closeDelay = 150,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return (
    <HoverCardPrimitive.Root
      data-slot="hover-card"
      openDelay={openDelay}
      closeDelay={closeDelay}
      {...props}
    />
  );
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
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  const container = usePortalContainer();
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal" container={container}>
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          FLOATING_SURFACE,
          ENTER_FAST,
          EXIT_FAST,
          'w-64 origin-(--radix-hover-card-content-transform-origin) p-3 outline-hidden',
          className
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
