/**
 * The menu that drops out of a button you clicked.
 *
 * Use it wherever there is an anchor to hang the menu off; use `ContextMenu`
 * when the menu belongs to a right-click on a region instead. For a menu that
 * should become a bottom sheet on a phone, an application wrapper can choose
 * between this menu and its own sheet.
 *
 * Every row and surface comes from `menu-item.ts`, shared with the context menu
 * and the select. Each surface grows out of the control that opened it rather than
 * out of its own middle.
 *
 * @module @dork-labs/ui/dropdown-menu
 */
import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';

import { cn } from './cn.js';
import {
  FLOATING_SURFACE,
  MENU_ITEM,
  MENU_ITEM_CHECKABLE,
  MENU_ITEM_GLYPH,
  MENU_ITEM_INSET,
  MENU_LABEL,
  MENU_SEPARATOR,
  MENU_SUB_CHEVRON,
  MENU_SURFACE,
  ENTER_FAST,
} from './menu-item.js';
import { usePortalContainer } from './ui-provider.js';

/** The menu itself — wraps a trigger and its content, and owns open/closed. */
function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

/** The control the menu drops out of. Pass `asChild` to use your own button. */
function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

/** A run of related items, so keyboard navigation and labels stay together. */
function DropdownMenuGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

/**
 * A nested menu — pair a {@link DropdownMenuSubTrigger} with a
 * {@link DropdownMenuSubContent} inside it.
 */
function DropdownMenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

/** A set of {@link DropdownMenuRadioItem}s where exactly one is chosen. */
function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

/** The menu panel itself, portalled into the provider host or document body. */
function DropdownMenuContent({
  className,
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  const portalContainer = usePortalContainer();
  return (
    <DropdownMenuPrimitive.Portal container={portalContainer}>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          FLOATING_SURFACE,
          MENU_SURFACE,
          'max-h-(--radix-dropdown-menu-content-available-height) overflow-x-hidden overflow-y-auto',
          // The menu grows out of the control you clicked, not out of its own
          // middle — Radix publishes the trigger-relative origin, and every other
          // overlay in the app already reads it.
          'origin-(--radix-dropdown-menu-content-transform-origin)',
          // OPENS WITH AN ANIMATION, CLOSES AT ONCE — and the second half is
          // load-bearing rather than a taste (DOR-1834). Radix keeps a menu
          // mounted for as long as it has a closing animation to play, and the
          // part of it that listens for "somebody pressed outside me" is kept
          // with it. So for the ~150ms a fade lasted, a press on the menu's own
          // button was answered twice: the button reopened the menu, and the
          // copy still finishing its fade read the same press as a press
          // outside and closed what had just opened. Two presses were needed;
          // the first did nothing at all.
          //
          // Restoring the fade needs Radix to be able to reopen a menu it is
          // still closing, and it cannot: the reopened menu is the SAME element
          // rather than a new one, so nothing puts the keyboard back inside it
          // and the arrow keys reach nothing. Leaving at once is what makes the
          // next press a clean start.
          ENTER_FAST,
          className
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

/** A non-clickable heading over a group of items. */
function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn(MENU_LABEL, className)}
      {...props}
    />
  );
}

/** The space between two groups of items. */
function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn(MENU_SEPARATOR, className)}
      {...props}
    />
  );
}

/**
 * One action in the menu.
 *
 * `variant="destructive"` turns it red — for deletes and anything else that
 * cannot be taken back. `inset` indents it to line up with checkable items.
 */
function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: 'default' | 'destructive';
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(MENU_ITEM, inset && MENU_ITEM_INSET, className)}
      {...props}
    />
  );
}

/** An item that carries an on/off state, shown as a tick in the left gutter. */
function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      checked={checked}
      className={cn(MENU_ITEM, MENU_ITEM_CHECKABLE, className)}
      {...props}
    >
      <span className={MENU_ITEM_GLYPH}>
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="size-(--dui-size-icon-sm)" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

/**
 * The item that opens a nested menu, with the chevron drawn for you.
 *
 * `inset` indents it to line up with items that carry a tick.
 */
function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & { inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(MENU_ITEM, inset && MENU_ITEM_INSET, className)}
      {...props}
    >
      {children}
      <ChevronRight className={MENU_SUB_CHEVRON} />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

/** The panel a nested menu opens into. */
function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  const portalContainer = usePortalContainer();
  return (
    <DropdownMenuPrimitive.Portal container={portalContainer}>
      <DropdownMenuPrimitive.SubContent
        data-slot="dropdown-menu-sub-content"
        className={cn(
          FLOATING_SURFACE,
          MENU_SURFACE,
          'overflow-hidden',
          // Same trigger-relative origin as the top-level menu: a submenu grows
          // out of the item that opened it.
          'origin-(--radix-dropdown-menu-content-transform-origin)',
          // And it leaves at once too — for consistency with its parent rather
          // than for its parent's reason. A submenu dismisses nothing on an
          // outside press (Radix gives it no `onDismiss` and leaves outside
          // pointer events alone), so it never ate anybody's click; it is that a
          // submenu lingering after the menu it belongs to has gone is a ghost,
          // not a fade (DOR-1834).
          ENTER_FAST,
          className
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

/** One option inside a {@link DropdownMenuRadioGroup}, ticked when chosen. */
function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(MENU_ITEM, MENU_ITEM_CHECKABLE, className)}
      {...props}
    >
      <span className={MENU_ITEM_GLYPH}>
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="size-(--dui-size-icon-sm)" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
