'use client';

import * as React from 'react';
import { XIcon } from 'lucide-react';
import { Dialog as SheetPrimitive } from 'radix-ui';

import { cn } from './cn.js';
import { MODAL_CLOCK } from './menu-item.js';
import { focusFirstFieldOrPanel } from './overlay-focus.js';
import { usePortalContainer } from './ui-provider.js';
import { Button } from './button.js';

/** Accessible slide-out panel root that manages open state. */
function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

/** Element that toggles the sheet panel open on click. */
function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

/** Element that dismisses the sheet panel on click. */
function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

/** Portals a sheet into the nearest configured host or an explicit container. */
function SheetPortal({ container, ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  const resolvedContainer = usePortalContainer(container);
  return (
    <SheetPrimitive.Portal data-slot="sheet-portal" container={resolvedContainer} {...props} />
  );
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        // Same clock as SheetContent so the scrim and the panel land together.
        // Left to itself the overlay takes tw-animate's 150ms default and the page
        // was fully dimmed while the panel was still sliding.
        MODAL_CLOCK,
        'bg-dui-scrim fixed inset-0 z-(--z-overlay)',
        className
      )}
      {...props}
    />
  );
}

/** Animated slide-out panel content with configurable side and close button. */
function SheetContent({
  className,
  children,
  side = 'right',
  showCloseButton = true,
  onOpenAutoFocus,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: 'top' | 'right' | 'bottom' | 'left';
  showCloseButton?: boolean;
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        onOpenAutoFocus={(event) => {
          onOpenAutoFocus?.(event);
          if (!event.defaultPrevented) focusFirstFieldOrPanel(event);
        }}
        className={cn(
          // 200ms in / 150ms out, ease-out arriving and ease-in leaving — the
          // design system's overlay row and its easing table. shadcn ships this
          // at 500ms in with `ease-in-out`, which made every drawer in the app
          // hesitate and then take longer than any other motion to finish.
          //
          // Flush to its edge, with no line or radius: the scrim and the lift carry
          // it, as they do a dialog.
          MODAL_CLOCK,
          'bg-dui-popover text-dui-popover-foreground fixed z-(--z-overlay) flex flex-col gap-4 shadow-xl transition outline-none',
          side === 'right' &&
            'data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right inset-y-0 right-0 h-full w-full sm:w-3/4 sm:max-w-sm',
          side === 'left' &&
            'data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left inset-y-0 left-0 h-full w-full sm:w-3/4 sm:max-w-sm',
          side === 'top' &&
            'data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top inset-x-0 top-0 h-auto',
          side === 'bottom' &&
            'data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom inset-x-0 bottom-0 h-auto',
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-dui-muted-foreground hover:text-dui-foreground absolute top-4 right-4"
            >
              <XIcon className="size-(--dui-size-icon-sm)" />
              <span className="sr-only">Close</span>
            </Button>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

/** Header layout container for sheet title and description. */
function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex flex-col gap-1 px-4 pt-4 pb-3', className)}
      {...props}
    />
  );
}

/** Footer layout container for sheet action buttons. */
function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn('mt-auto flex flex-col gap-2 p-4', className)}
      {...props}
    />
  );
}

/** Accessible title heading for the sheet panel. */
function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('text-dui-foreground pr-12 text-base font-semibold', className)}
      {...props}
    />
  );
}

/** Muted description text for the sheet panel. */
function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-dui-muted-foreground text-sm', className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetPortal,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
