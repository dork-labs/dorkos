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
import { cn } from '@/layers/shared/lib/utils';
import { Button } from './button';

interface ResponsivePopoverContextValue {
  isDesktop: boolean;
  fullHeight: boolean;
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

export interface ResponsivePopoverProps {
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Keep Tab inside the panel and block pointer input behind it. Off by
   * default, which is right for a _glance_ — a status readout you tab past.
   * Turn it on for a _task_: a picker you have to finish or abandon wants
   * Tab to stay inside it and Escape to be the way out. The mobile sheet
   * traps focus either way.
   */
  modal?: boolean;
  /**
   * Mobile only, ignored on desktop. Give the sheet the whole screen instead
   * of letting it hug its content, put a close button in its corner, and trim
   * its heading to the height a heading needs.
   *
   * Turn it on for a _task_ — anything with a text field, a list to scan and a
   * button at the end. A content-height sheet puts all three in the bottom
   * fifth of the screen, which is precisely where a software keyboard lands.
   * Filling the screen moves the field to the top, above the keyboard, and
   * gives the list room to be a list. Leave it off for a short menu.
   *
   * Lives on the root rather than on `Content` because the heading has to know
   * too, and the heading is `Content`'s sibling.
   */
  fullHeight?: boolean;
}

/** Renders a Popover on desktop or a bottom Drawer on mobile. */
function ResponsivePopover({ children, fullHeight = false, ...props }: ResponsivePopoverProps) {
  const isDesktop = !useIsMobile();
  const Comp = isDesktop ? Popover : Drawer;

  const ctxValue = React.useMemo<ResponsivePopoverContextValue>(
    () => ({ isDesktop, fullHeight }),
    [isDesktop, fullHeight]
  );

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
  ...props
}: React.ComponentPropsWithoutRef<typeof PopoverContent>) {
  const { isDesktop, fullHeight } = useResponsivePopover();

  if (isDesktop) {
    return (
      <PopoverContent
        side={side}
        align={align}
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
        <DrawerClose asChild>
          <Button
            variant="ghost"
            size="icon-md"
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground absolute top-2 right-2"
          >
            <XIcon className="size-5" />
          </Button>
        </DrawerClose>
      )}
      <div
        className={cn(
          'px-4 pb-4',
          // `overflow-y-auto` is the scroll of last resort, and it is not
          // redundant with the column below it. vaul shrinks this sheet to
          // whatever the software keyboard leaves — on a landscape phone that
          // is barely 200px — and a flex column cannot shrink the parts that
          // do not shrink. Without it, a field and a button that no longer fit
          // are drawn *outside* the sheet, over the keyboard: measured at
          // 667×375 with a 162px keyboard, the commit button's lower half was
          // unreachable.
          fullHeight ? 'flex min-h-0 flex-1 flex-col overflow-y-auto' : 'flex-1 overflow-y-auto'
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
  const { isDesktop, fullHeight } = useResponsivePopover();
  if (isDesktop) return null;
  return (
    <DrawerHeader
      className={cn(
        // A full-height sheet spends its height on the task, not on its own
        // chrome: no horizontal padding (the panel already has it), a single
        // line of vertical space, and a right inset that keeps any title —
        // not just a short one — clear of the close button.
        //
        // Under 450px of viewport it stops being drawn at all and survives only
        // as the sheet's accessible name. That height is a landscape phone and
        // nothing else — every phone in portrait is 600px or taller — and it is
        // the one case where 40px of heading is the difference between seeing
        // the matches you are typing to find and seeing none of them. The close
        // button is still there, so the sheet keeps a visible way out.
        fullHeight && 'shrink-0 px-0 pt-1 pr-14 pb-3 text-left [@media(max-height:450px)]:sr-only'
      )}
    >
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
