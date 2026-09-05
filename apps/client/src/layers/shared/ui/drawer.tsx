/**
 * The bottom sheet — a panel that slides up from the bottom edge of the screen.
 *
 * The phone half of `ResponsiveDialog`: the same content that is a centred box on
 * a desktop becomes a sheet a thumb can reach and drag away. Built on `vaul`, so
 * the drag-to-dismiss gesture and the grabber at the top come for free.
 *
 * @module shared/ui/drawer
 */
import * as React from 'react';
import { Drawer as DrawerPrimitive } from 'vaul';

import { cn } from '@/layers/shared/lib/utils';

/**
 * The sheet itself — wraps a trigger and its content, and owns open/closed.
 *
 * `shouldScaleBackground` pushes the page back a little as the sheet rises,
 * which is what makes it read as a layer above rather than a panel beside.
 */
function Drawer({
  shouldScaleBackground = true,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root shouldScaleBackground={shouldScaleBackground} {...props} />;
}

/** The control that raises the sheet. Pass `asChild` to use your own button. */
function DrawerTrigger({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

/**
 * Renders the sheet at the end of the document, clear of any clipping ancestor.
 *
 * {@link DrawerContent} already portals itself, so this is only needed when
 * building a content surface by hand.
 */
function DrawerPortal({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal {...props} />;
}

/** A control that lowers the sheet. Pass `asChild` to use your own button. */
function DrawerClose({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

/**
 * The dimmed sheet behind the drawer that swallows clicks on the page.
 *
 * {@link DrawerContent} renders one for you — reach for this only when composing
 * a content surface from the parts.
 */
function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
  return (
    <DrawerPrimitive.Overlay
      data-slot="drawer-overlay"
      className={cn('fixed inset-0 z-50 bg-black/80', className)}
      {...props}
    />
  );
}

/**
 * The panel that slides up, with the grabber already drawn at the top.
 *
 * **The home-indicator gap is already handled, and not from here.** vaul stamps
 * `data-vaul-drawer` on this element, and `index.css` pads that selector by
 * `env(safe-area-inset-bottom)` for every drawer in the app at once — so there
 * is no inset class in the list below, and adding one would double the gap on a
 * notched phone. `viewport-fit=cover` in `index.html` is what makes the value
 * non-zero.
 *
 * **The height is the caller's.** `bottom-0` with `h-auto` means a sheet grows
 * with whatever is inside it, past the top of the screen if there is enough —
 * `mt-24` cannot stop it, because a margin-top does nothing to a fixed box whose
 * `top` is `auto`. Every dialog in this app caps itself at `max-h-[85vh]` and
 * puts one scrolling region inside; a new one has to do the same.
 */
function DrawerContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content>) {
  return (
    <DrawerPortal>
      <DrawerOverlay />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          'bg-background fixed inset-x-0 bottom-0 z-50 mt-24 flex h-auto flex-col rounded-t-[10px] border',
          className
        )}
        {...props}
      >
        <div className="bg-muted mx-auto mt-4 h-2 w-[100px] rounded-full" />
        {children}
      </DrawerPrimitive.Content>
    </DrawerPortal>
  );
}

/** Stacks the title and description at the top of the sheet. */
function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-header"
      className={cn('grid gap-1.5 p-4 text-center sm:text-left', className)}
      {...props}
    />
  );
}

/**
 * Stacks the sheet's buttons at the bottom, pushed down to the edge.
 *
 * Always a column, unlike `DialogFooter` — a sheet is a phone surface, and two
 * full-width buttons are easier to hit than two side by side.
 */
function DrawerFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn('mt-auto flex flex-col gap-2 p-4', className)}
      {...props}
    />
  );
}

/**
 * The sheet's heading, and the name a screen reader announces on open.
 *
 * Every drawer needs one. When the design has no visible heading, keep the title
 * and hide it with `sr-only` rather than dropping it.
 */
function DrawerTitle({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn('text-lg leading-none font-semibold tracking-tight', className)}
      {...props}
    />
  );
}

/** One quiet line under the title saying what the sheet is for. */
function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerClose,
  DrawerTrigger,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
};
