import * as React from 'react';
import { XIcon } from 'lucide-react';
import { useIsMobile } from '../model';
import { Popover, PopoverTrigger, PopoverContent } from './popover';
import {
  Drawer,
  DrawerTrigger,
  DrawerContent,
  DrawerClose,
  DrawerHeader,
  DrawerTitle,
} from './drawer';
import { cn } from '../lib/utils';

interface ResponsivePopoverContextValue {
  isDesktop: boolean;
}

const ResponsivePopoverContext = React.createContext<ResponsivePopoverContextValue | undefined>(
  undefined
);

/** Read responsive popover context. Throws if used outside a ResponsivePopover. */
function useResponsivePopover(): ResponsivePopoverContextValue {
  const ctx = React.useContext(ResponsivePopoverContext);
  if (!ctx) {
    throw new Error('useResponsivePopover must be used within a <ResponsivePopover>');
  }
  return ctx;
}

interface ResponsivePopoverProps {
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Trap focus and block the page behind while open. Off by default, which is
   * right for a _glance_ — a status readout you tab past. Turn it on for a
   * _task_: a picker you have to finish or abandon wants Tab to stay inside it
   * and Escape to be the way out. The mobile sheet is modal either way.
   */
  modal?: boolean;
}

/** Renders a Popover on desktop or a bottom Drawer on mobile. */
function ResponsivePopover({ children, ...props }: ResponsivePopoverProps) {
  const isDesktop = !useIsMobile();
  const Comp = isDesktop ? Popover : Drawer;

  const ctxValue = React.useMemo<ResponsivePopoverContextValue>(() => ({ isDesktop }), [isDesktop]);

  return (
    <ResponsivePopoverContext.Provider value={ctxValue}>
      <Comp {...props}>{children}</Comp>
    </ResponsivePopoverContext.Provider>
  );
}
ResponsivePopover.displayName = 'ResponsivePopover';

/** Trigger that opens the responsive popover or drawer. */
function ResponsivePopoverTrigger({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof PopoverTrigger>) {
  const { isDesktop } = useResponsivePopover();
  const Comp = isDesktop ? PopoverTrigger : DrawerTrigger;
  return (
    <Comp className={className} {...props}>
      {children}
    </Comp>
  );
}
ResponsivePopoverTrigger.displayName = 'ResponsivePopoverTrigger';

/** Content panel — Popover on desktop, bottom Drawer on mobile. */
function ResponsivePopoverContent({
  className,
  children,
  side,
  align,
  fullHeight = false,
  ...props
}: React.ComponentPropsWithoutRef<typeof PopoverContent> & {
  side?: string;
  align?: string;
  /**
   * Mobile only, ignored on desktop. Give the sheet the whole screen instead of
   * letting it hug its content, and pin a close button in its corner.
   *
   * Turn it on for a _task_ — anything with a text field, a list to scan and a
   * button at the end. A content-height sheet puts all three in the bottom
   * fifth of the screen, which is precisely where a software keyboard lands.
   * Filling the screen moves the field to the top, above the keyboard, and
   * gives the list room to be a list. Leave it off for a short menu.
   */
  fullHeight?: boolean;
}) {
  const { isDesktop } = useResponsivePopover();

  if (isDesktop) {
    return (
      <PopoverContent
        side={side as 'top' | 'bottom' | 'left' | 'right'}
        align={align as 'start' | 'center' | 'end'}
        className={cn('max-h-[min(70vh,600px)] w-80 overflow-y-auto', className)}
        {...props}
      >
        {children}
      </PopoverContent>
    );
  }
  // Drawer is always full-width — ignore caller's className (which may have
  // width constraints like w-72 intended for the desktop Popover).
  return (
    // Nothing here compensates for a software keyboard, deliberately: vaul
    // already shrinks the drawer to the visual viewport whenever a field
    // inside it has focus (`repositionInputs`). Padding the box for the
    // keyboard on top of that subtracts the same height twice — measured on a
    // 390×844 phone with a 320px keyboard, it squeezed the result list to
    // exactly 0px while leaving 261px of blank sheet underneath.
    <DrawerContent
      className={cn('flex flex-col', fullHeight ? 'mt-0 h-[92dvh] max-h-none' : 'max-h-[90vh]')}
      {...props}
    >
      {fullHeight && (
        <DrawerClose className="ring-offset-background focus-visible:ring-ring text-muted-foreground hover:text-foreground absolute top-3 right-3 flex size-9 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden">
          <XIcon className="size-5" />
          <span className="sr-only">Close</span>
        </DrawerClose>
      )}
      <div
        className={cn(
          'px-4 pb-4',
          fullHeight ? 'flex min-h-0 flex-1 flex-col' : 'flex-1 overflow-y-auto'
        )}
      >
        {children}
      </div>
    </DrawerContent>
  );
}
ResponsivePopoverContent.displayName = 'ResponsivePopoverContent';

/** Title shown only in the Drawer variant (mobile). Returns null on desktop. */
function ResponsivePopoverTitle({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  const { isDesktop } = useResponsivePopover();
  if (isDesktop) return null;
  return (
    <DrawerHeader>
      <DrawerTitle className={className} {...props}>
        {children}
      </DrawerTitle>
    </DrawerHeader>
  );
}
ResponsivePopoverTitle.displayName = 'ResponsivePopoverTitle';

export {
  ResponsivePopover,
  ResponsivePopoverTrigger,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  useResponsivePopover,
};
