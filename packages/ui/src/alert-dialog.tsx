/**
 * The confirmation dialog — "are you sure?" before something that cannot be undone.
 *
 * Same box as `Dialog`, but with two differences that matter: it has exactly two
 * visible exits ({@link AlertDialogAction} and {@link AlertDialogCancel}, already styled
 * as buttons) and it cannot be dismissed by clicking away. Radix also allows
 * Escape to dismiss it, preserving keyboard users' expected way back.
 * For anything the reader can back out of, use `Dialog`.
 *
 * @module shared/ui/alert-dialog
 */
import * as React from 'react';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';

import { cn } from './cn.js';
import { usePortalContainer } from './ui-provider.js';
import { buttonVariants } from './button.js';
import { TOUCH_TARGET_RESPONSIVE_H } from './touch-target.js';

/** The confirmation itself — wraps a trigger and its content, and owns open/closed. */
function AlertDialog({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

/** The control that asks the question. Pass `asChild` to use your own button. */
function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

/**
 * Renders the dialog in its explicit container or provider host, defaulting to the document body.
 *
 * {@link AlertDialogContent} already portals itself, so this is only needed when
 * building a content surface by hand.
 */
function AlertDialogPortal({
  container,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  const resolvedContainer = usePortalContainer(container);
  return (
    <AlertDialogPrimitive.Portal
      data-slot="alert-dialog-portal"
      container={resolvedContainer}
      {...props}
    />
  );
}

/**
 * The dimmed sheet behind the dialog that swallows clicks on the page.
 *
 * {@link AlertDialogContent} renders one for you — reach for this only when
 * composing a content surface from the parts.
 */
function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/80 motion-reduce:animate-none!',
        className
      )}
      {...props}
    />
  );
}

/**
 * The confirmation's panel: the box and its overlay, portalled out.
 *
 * No built-in close button, unlike `DialogContent`. The caller supplies the
 * action and cancel controls; Radix also permits Escape to dismiss the dialog.
 */
function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          // Same side gutter, same always-on corners and same content-can't-widen-
          // the-column track as `DialogContent` — a confirmation is the dialog
          // people meet on a phone most often, and it must not be the one that
          // meets both screen edges.
          'bg-dui-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 border-dui-border fixed top-[50%] left-[50%] z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] grid-cols-[minmax(0,1fr)] gap-4 overflow-y-auto rounded-lg border p-6 shadow-lg duration-200 motion-reduce:animate-none! motion-reduce:transition-none!',
          className
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

/** Stacks the title and description at the top of the confirmation. */
function AlertDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn('flex flex-col space-y-2 text-center sm:text-left', className)}
      {...props}
    />
  );
}

/**
 * Lays the two answers out along the bottom.
 *
 * Side by side and right-aligned on a wide screen; stacked on a narrow one, with
 * the action on top and cancel underneath it.
 */
function AlertDialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
      {...props}
    />
  );
}

/**
 * The question, and the name a screen reader announces on open.
 *
 * Ask it plainly — "Delete this room?" reads better than "Confirm deletion".
 */
function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn('text-lg font-semibold', className)}
      {...props}
    />
  );
}

/** One line under the question saying what saying yes will actually do. */
function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn('text-dui-muted-foreground text-sm', className)}
      {...props}
    />
  );
}

/**
 * The button that goes through with it, already wearing `Button`'s default look.
 *
 * Pass `className={buttonVariants({ variant: 'destructive' })}` when the answer
 * deletes something, so the colour matches the consequence.
 */
function AlertDialogAction({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action>) {
  return (
    <AlertDialogPrimitive.Action
      data-slot="alert-dialog-action"
      // `buttonVariants()` alone is the 36px desktop height; `Button` adds the
      // phone touch target itself, so these exits add it the same way.
      className={cn(buttonVariants(), TOUCH_TARGET_RESPONSIVE_H, className)}
      {...props}
    />
  );
}

/** The button that backs out, already wearing `Button`'s outline look. */
function AlertDialogCancel({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <AlertDialogPrimitive.Cancel
      data-slot="alert-dialog-cancel"
      className={cn(
        buttonVariants({ variant: 'outline' }),
        TOUCH_TARGET_RESPONSIVE_H,
        'mt-2 sm:mt-0',
        className
      )}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};
