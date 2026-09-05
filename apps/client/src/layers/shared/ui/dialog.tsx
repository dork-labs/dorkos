/**
 * The modal dialog — a box the reader must answer before going back to the page.
 *
 * DorkOS adds three things upstream shadcn does not, and they are the reason
 * this file is not a straight re-export: {@link DialogContent} portals itself
 * and draws its own {@link DialogOverlay}, it injects a close button in the top
 * corner (so no caller renders one), and it caps its own height and scrolls
 * inside that cap rather than hanging off both ends of a phone screen.
 *
 * For a surface that should become a bottom sheet on a phone, use
 * `ResponsiveDialog` instead — it picks between this and `Drawer` for you.
 *
 * @module shared/ui/dialog
 */
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { cn } from '@/layers/shared/lib/utils';

/**
 * The dialog itself — wraps a trigger and its content, and owns open/closed.
 *
 * Renders no markup of its own; drive it with `open`/`onOpenChange` when the
 * page decides, or leave it uncontrolled and let {@link DialogTrigger} do it.
 */
function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

/** The control that opens the dialog. Pass `asChild` to use your own button. */
function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

/**
 * Renders the dialog at the end of the document, clear of any clipping ancestor.
 *
 * {@link DialogContent} already portals itself, so this is only needed when
 * building a content surface by hand.
 */
function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

/** A control that closes the dialog. Pass `asChild` to use your own button. */
function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/**
 * The dimmed sheet behind the dialog that swallows clicks on the page.
 *
 * {@link DialogContent} renders one for you — reach for this only when composing
 * a content surface from the parts.
 */
function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/80',
        className
      )}
      {...props}
    />
  );
}

/**
 * The dialog's panel: the box, its overlay, and the close button in the corner.
 *
 * It portals and dims on its own, so a caller supplies only the contents. Do not
 * add a close button — one is already drawn top-right, pinned there while the
 * body scrolls.
 */
function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          // `w-[calc(100%-2rem)]`, not `w-full`: a fixed, viewport-centred box at
          // full width has no side gutter at all, so below 512px the dialog met
          // both screen edges. And the corners are rounded at EVERY width — behind
          // a `sm:` prefix a phone got a flush square rectangle, which reads as a
          // page that failed to load rather than as a card.
          //
          // `grid-cols-[minmax(0,1fr)]` is what keeps content inside that box. A
          // grid's default `auto` track is sized by its content, so one wide child
          // widened the column past the dialog and every sibling stretched out
          // with it — a heading and a paragraph painting over the page beside a
          // phone-width dialog. Pinning the track to the box is the same width in
          // every case that already fit, and the only difference in the ones that
          // did not.
          //
          // The same gutter top and bottom, and a scroller when the content is
          // taller than that. A centred box with no height cap does not clip —
          // it hangs off both ends of the screen at once, with no way to reach
          // either, and text that wraps to more lines on a phone is exactly when
          // it happens.
          'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] grid-cols-[minmax(0,1fr)] gap-4 overflow-y-auto rounded-lg border p-6 shadow-lg duration-200',
          className
        )}
        {...props}
      >
        {children}
        {/* `row-span-full` + `sticky`, not `absolute`: the box above can now
            scroll (see the height-cap comment above), and an
            absolutely-positioned child of a scroll container scrolls away with
            everything else. Spanning every row keeps this overlaying the
            content instead of landing in its own row below it — the same
            visual role `absolute` used to play — and `sticky` then pins it to
            the same corner for as long as the dialog stays open, scrolled or
            not. The negative margins pull it back from the grid's padded edge
            to the original 16px inset (`top-4`/`right-4`) rather than the
            content's 24px one. */}
        <DialogPrimitive.Close
          data-slot="dialog-content-close"
          className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground sticky top-4 row-span-full -mt-2 -mr-2 self-start justify-self-end rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-none disabled:pointer-events-none"
        >
          <X className="size-(--size-icon-md)" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

/** Stacks the title and description at the top of the dialog. */
function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)}
      {...props}
    />
  );
}

/**
 * Lays the dialog's buttons out along the bottom.
 *
 * Side by side and right-aligned on a wide screen; stacked on a narrow one, with
 * the primary action on top where a thumb reaches it first.
 */
function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
      {...props}
    />
  );
}

/**
 * The dialog's heading, and the name a screen reader announces on open.
 *
 * Every dialog needs one. When the design has no visible heading, keep the title
 * and hide it with `sr-only` rather than dropping it.
 */
function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-lg leading-none font-semibold tracking-tight', className)}
      {...props}
    />
  );
}

/** One quiet line under the title saying what the dialog is asking for. */
function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
