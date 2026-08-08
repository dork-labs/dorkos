import * as React from 'react';
import { useIsMobile } from '../model';
import { useLongPress, type LongPressState } from '../model';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from './context-menu';
import { Drawer, DrawerContent } from './drawer';
import { cn } from '../lib/utils';

// ── Context ──

const ResponsiveContextMenuContext = React.createContext<{
  isDesktop: boolean;
  close: () => void;
  open: () => void;
  /**
   * Set by a `movesFocus` item: its action is placing focus itself, so the menu
   * must not take focus back on its way out. Cleared by the content.
   */
  keepsFocus: React.RefObject<boolean>;
}>({
  isDesktop: true,
  close: () => {},
  open: () => {},
  keepsFocus: { current: false },
});

// ── Root ──

interface ResponsiveContextMenuProps {
  children: React.ReactNode;
}

/** Renders a context menu on desktop (right-click) or a drawer on mobile (long-press). */
function ResponsiveContextMenu({ children }: ResponsiveContextMenuProps) {
  const isDesktop = !useIsMobile();
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const keepsFocus = React.useRef(false);

  const close = React.useCallback(() => setDrawerOpen(false), []);
  const open = React.useCallback(() => setDrawerOpen(true), []);

  if (isDesktop) {
    return (
      <ResponsiveContextMenuContext.Provider value={{ isDesktop, close, open, keepsFocus }}>
        <ContextMenu>{children}</ContextMenu>
      </ResponsiveContextMenuContext.Provider>
    );
  }

  return (
    <ResponsiveContextMenuContext.Provider value={{ isDesktop, close, open, keepsFocus }}>
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
        {children}
      </Drawer>
    </ResponsiveContextMenuContext.Provider>
  );
}

// ── Trigger ──

interface ResponsiveContextMenuTriggerProps {
  asChild?: boolean;
  children: React.ReactNode;
  className?: string;
  /**
   * Where the long press is in its life, on a touch screen.
   *
   * Opt-in, and mobile-only by construction: a desktop right-click has no press
   * to acknowledge. A surface that wants to give under the finger (a room's
   * message does) listens; everything else passes nothing and behaves exactly as
   * it did.
   */
  onPressStateChange?: (state: LongPressState) => void;
}

/** Trigger element — right-click on desktop, long-press on mobile. */
function ResponsiveContextMenuTrigger({
  asChild,
  children,
  className,
  onPressStateChange,
}: ResponsiveContextMenuTriggerProps) {
  const { isDesktop } = React.useContext(ResponsiveContextMenuContext);

  if (isDesktop) {
    return (
      <ContextMenuTrigger data-slot="context-menu-trigger" asChild={asChild} className={className}>
        {children}
      </ContextMenuTrigger>
    );
  }

  return (
    <MobileTrigger asChild={asChild} className={className} onPressStateChange={onPressStateChange}>
      {children}
    </MobileTrigger>
  );
}

/**
 * The attribute a nested trigger marks itself with to claim gesture priority
 * over this one. See `useLongPress`'s `yieldToSelector` doc for the full
 * contract — this is the one selector every `MobileTrigger` yields to, so any
 * surface nested inside a `ResponsiveContextMenuTrigger` can opt in just by
 * carrying this attribute on its own long-press's own trigger element.
 */
const GESTURE_PRIORITY_SELECTOR = '[data-gesture-priority]';

/** Mobile trigger that opens the drawer on long-press (pointer hold). */
function MobileTrigger({
  asChild,
  children,
  className,
  onPressStateChange,
}: ResponsiveContextMenuTriggerProps) {
  const { open } = React.useContext(ResponsiveContextMenuContext);

  const longPressHandlers = useLongPress({
    onLongPress: open,
    onPressStateChange,
    yieldToSelector: GESTURE_PRIORITY_SELECTOR,
  });

  if (asChild && React.isValidElement(children)) {
    // Spread long-press handlers onto the child element directly
    return React.cloneElement(children as React.ReactElement<React.HTMLAttributes<HTMLElement>>, {
      ...longPressHandlers,
      className: cn(
        (children as React.ReactElement<{ className?: string }>).props.className,
        className
      ),
    });
  }

  return (
    <div
      data-slot="context-menu-trigger"
      className={cn('contents', className)}
      {...longPressHandlers}
    >
      {children}
    </div>
  );
}

// ── Content ──

/** Content panel for the responsive context menu or drawer. */
function ResponsiveContextMenuContent({
  className,
  children,
  onCloseAutoFocus,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuContent>) {
  const { isDesktop, keepsFocus } = React.useContext(ResponsiveContextMenuContext);

  // The second half of what a `movesFocus` item asked for: as the surface
  // finally goes, it hands focus back to whatever was focused when it opened —
  // from a timer that fires after the closing animation, so it always lands
  // last. When the action placed the caret itself, that restore would undo it
  // (DOR-1038), so it is skipped for this one close. Escape, and every other
  // item, still hand focus back to the row a keyboard user came from.
  const handleCloseAutoFocus = (event: Event) => {
    onCloseAutoFocus?.(event);
    if (!keepsFocus.current) return;
    keepsFocus.current = false;
    event.preventDefault();
  };

  if (isDesktop) {
    return (
      <ContextMenuContent className={className} onCloseAutoFocus={handleCloseAutoFocus} {...props}>
        {children}
      </ContextMenuContent>
    );
  }

  return (
    <DrawerContent onCloseAutoFocus={handleCloseAutoFocus}>
      <div className="pb-6">{children}</div>
    </DrawerContent>
  );
}

// ── Item ──

interface ResponsiveContextMenuItemProps extends React.ComponentPropsWithoutRef<
  typeof ContextMenuItem
> {
  /**
   * This item's action puts the caret somewhere on purpose — in the chat
   * composer, say — rather than leaving it on the row the menu opened from.
   *
   * Such an action runs a beat later than the others, once the menu has begun
   * closing, and the menu then leaves focus where the action put it. Both halves
   * are needed: while a menu is open it traps focus, so an action that focuses
   * anything outside is undone on the spot, and as the menu goes it hands focus
   * back to the row (DOR-1038).
   *
   * An action that ends up moving no focus — because it could not do the thing —
   * gets the ordinary restore, and every other item is untouched.
   */
  movesFocus?: boolean;
}

/** Menu item for the responsive context menu or drawer. */
function ResponsiveContextMenuItem({
  className,
  children,
  onClick,
  variant = 'default',
  disabled,
  movesFocus = false,
  ...props
}: ResponsiveContextMenuItemProps) {
  const { isDesktop, close, keepsFocus } = React.useContext(ResponsiveContextMenuContext);

  const runAction = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!movesFocus) {
      onClick?.(event);
      return;
    }
    // A menu stops trapping focus the moment it starts closing, which is one
    // turn of the event loop from here — so this is the first instant an action
    // can put the caret somewhere else and have it stay. `keepsFocus` covers the
    // other end: the menu's own focus restore, which lands later still.
    keepsFocus.current = true;
    setTimeout(() => {
      const before = document.activeElement;
      onClick?.(event);
      // An action can decline to move focus after all — "Add to Chat" with no
      // chat open only says so — and then the row should get focus back like it
      // does from every other item. Cheaper to ask than to promise.
      const after = document.activeElement;
      if (after === before || after === null || after === document.body) {
        keepsFocus.current = false;
      }
    }, 0);
  };

  if (isDesktop) {
    return (
      <ContextMenuItem
        data-slot="context-menu-item"
        className={className}
        onClick={runAction}
        variant={variant}
        disabled={disabled}
        {...props}
      >
        {children}
      </ContextMenuItem>
    );
  }

  // `disabled` is pulled out and applied by hand: the drawer branch renders a
  // plain button rather than the Radix item, and an item that is dimmed on
  // desktop but tappable on a phone is worse than one that was never offered.
  return (
    <button
      type="button"
      data-slot="context-menu-item"
      data-variant={variant}
      disabled={disabled}
      className={cn(
        'border-border flex w-full items-center gap-2 border-b px-4 py-3 text-left text-sm transition-colors',
        'active:bg-accent/50 min-h-[44px]',
        'last:border-b-0',
        'disabled:pointer-events-none disabled:opacity-50',
        variant === 'destructive' && 'text-destructive',
        className
      )}
      onClick={(e) => {
        runAction(e as unknown as React.MouseEvent<HTMLDivElement>);
        close();
      }}
    >
      {children}
    </button>
  );
}

// ── Separator ──

/** Separator between context menu items. No-op on mobile (items use border-b). */
function ResponsiveContextMenuSeparator({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuSeparator>) {
  const { isDesktop } = React.useContext(ResponsiveContextMenuContext);

  if (isDesktop) {
    return (
      <ContextMenuSeparator data-slot="context-menu-separator" className={className} {...props} />
    );
  }

  // On mobile, items already have border-b — separator is a no-op
  return null;
}

/**
 * The open menu's own frame and controls.
 *
 * Exported so content INSIDE the menu can do what a menu item does — close the
 * surface after acting — without being a menu item. A room's drawer opens with a
 * row of emoji rather than a list row, and a reaction that left the drawer
 * standing open would hide the pill it just added.
 */
function useResponsiveContextMenu() {
  return React.useContext(ResponsiveContextMenuContext);
}

export {
  useResponsiveContextMenu,
  ResponsiveContextMenu,
  ResponsiveContextMenuTrigger,
  ResponsiveContextMenuContent,
  ResponsiveContextMenuItem,
  ResponsiveContextMenuSeparator,
};
