import * as React from 'react';
import { CheckIcon, ChevronRightIcon, CircleIcon } from 'lucide-react';
import { ContextMenu as ContextMenuPrimitive } from 'radix-ui';

import { cn } from './cn.js';
import {
  ENTER_FAST,
  FLOATING_SURFACE,
  MENU_ITEM,
  MENU_ITEM_CHECKABLE,
  MENU_ITEM_GLYPH,
  MENU_ITEM_INSET,
  MENU_LABEL,
  MENU_SEPARATOR,
  MENU_SHORTCUT,
  MENU_SUB_CHEVRON,
  MENU_SURFACE,
} from './menu-item.js';
import { usePortalContainer } from './ui-provider.js';

/**
 * The right-click menu, wrapping the area that owns it.
 *
 * One trigger, one content. It opens where the pointer is rather than under an
 * anchor, which is the whole difference from `DropdownMenu` — reach for that one
 * when there is a button to hang the menu off.
 */
function ContextMenu({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

/**
 * The region a right-click (or long-press) opens the menu over.
 */
function ContextMenuTrigger({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

/**
 * A run of related items, so keyboard navigation and labels stay together.
 */
function ContextMenuGroup({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Group>) {
  return <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />;
}

/**
 * Renders the menu in its explicit container or provider host, defaulting to the document body.
 *
 * {@link ContextMenuContent} already portals itself, so this is only needed when
 * building a content surface by hand.
 */
function ContextMenuPortal({
  container,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Portal>) {
  const portalContainer = usePortalContainer(container);
  return (
    <ContextMenuPrimitive.Portal
      data-slot="context-menu-portal"
      container={portalContainer}
      {...props}
    />
  );
}

/**
 * A nested menu — pair a {@link ContextMenuSubTrigger} with a
 * {@link ContextMenuSubContent} inside it.
 */
function ContextMenuSub({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />;
}

/**
 * A set of {@link ContextMenuRadioItem}s where exactly one is chosen.
 */
function ContextMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  return <ContextMenuPrimitive.RadioGroup data-slot="context-menu-radio-group" {...props} />;
}

/**
 * The item that opens a nested menu, with the chevron drawn for you.
 *
 * `inset` indents it to line up with items that carry a check or a radio dot.
 */
function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.SubTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(MENU_ITEM, inset && MENU_ITEM_INSET, className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className={MENU_SUB_CHEVRON} />
    </ContextMenuPrimitive.SubTrigger>
  );
}

/**
 * The panel a nested menu opens into.
 */
function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ContextMenuPrimitive.SubContent
      data-slot="context-menu-sub-content"
      className={cn(
        FLOATING_SURFACE,
        MENU_SURFACE,
        ENTER_FAST,
        'origin-(--radix-context-menu-content-transform-origin) overflow-hidden',
        className
      )}
      {...props}
    />
  );
}

/**
 * The menu panel itself, portalled into the provider host or document body.
 *
 * Scrolls inside its own height rather than pushing the page, so a long menu
 * never runs off the bottom of the window.
 */
function ContextMenuContent({
  className,
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  const portalContainer = usePortalContainer();
  return (
    <ContextMenuPrimitive.Portal container={portalContainer}>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        collisionPadding={collisionPadding}
        className={cn(
          FLOATING_SURFACE,
          MENU_SURFACE,
          // Opens with an animation and closes at once, as the dropdown does: a
          // closing menu eats the next press (DOR-1834).
          ENTER_FAST,
          'max-h-(--radix-context-menu-content-available-height) origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto',
          className
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

/**
 * One action in the menu.
 *
 * `variant="destructive"` turns it red — for deletes and anything else that
 * cannot be taken back. `inset` indents it to line up with checkable items.
 */
function ContextMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: 'default' | 'destructive';
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(MENU_ITEM, inset && MENU_ITEM_INSET, className)}
      {...props}
    />
  );
}

/**
 * An item that carries an on/off state, shown as a tick in the left gutter.
 */
function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      className={cn(MENU_ITEM, MENU_ITEM_CHECKABLE, className)}
      checked={checked}
      {...props}
    >
      <span className={MENU_ITEM_GLYPH}>
        <ContextMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-(--dui-size-icon-sm)" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  );
}

/**
 * One option inside a {@link ContextMenuRadioGroup}, shown as a dot when chosen.
 */
function ContextMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem>) {
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot="context-menu-radio-item"
      className={cn(MENU_ITEM, MENU_ITEM_CHECKABLE, className)}
      {...props}
    >
      <span className={MENU_ITEM_GLYPH}>
        <ContextMenuPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  );
}

/**
 * A non-clickable heading over a group of items.
 */
function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.Label
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn(MENU_LABEL, 'data-[inset]:pl-8', className)}
      {...props}
    />
  );
}

/**
 * The space between two groups of items.
 */
function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn(MENU_SEPARATOR, className)}
      {...props}
    />
  );
}

/**
 * The keyboard shortcut for an item, pushed to the right edge.
 *
 * A hint only — it does not bind the key. Register that where the command lives.
 */
function ContextMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span data-slot="context-menu-shortcut" className={cn(MENU_SHORTCUT, className)} {...props} />
  );
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
};
