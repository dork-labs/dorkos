import * as React from 'react';
import { useIsMobile } from '../model';
import { useLongPress } from '../model';
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
}>({
  isDesktop: true,
  close: () => {},
  open: () => {},
});

// ── Root ──

interface ResponsiveContextMenuProps {
  children: React.ReactNode;
}

/** Renders a context menu on desktop (right-click) or a drawer on mobile (long-press). */
function ResponsiveContextMenu({ children }: ResponsiveContextMenuProps) {
  const isDesktop = !useIsMobile();
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  const close = React.useCallback(() => setDrawerOpen(false), []);
  const open = React.useCallback(() => setDrawerOpen(true), []);

  if (isDesktop) {
    return (
      <ResponsiveContextMenuContext.Provider value={{ isDesktop, close, open }}>
        <ContextMenu>{children}</ContextMenu>
      </ResponsiveContextMenuContext.Provider>
    );
  }

  return (
    <ResponsiveContextMenuContext.Provider value={{ isDesktop, close, open }}>
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
}

/** Trigger element — right-click on desktop, long-press on mobile. */
function ResponsiveContextMenuTrigger({
  asChild,
  children,
  className,
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
    <MobileTrigger asChild={asChild} className={className}>
      {children}
    </MobileTrigger>
  );
}

/** Mobile trigger that opens the drawer on long-press (pointer hold). */
function MobileTrigger({ asChild, children, className }: ResponsiveContextMenuTriggerProps) {
  const { open } = React.useContext(ResponsiveContextMenuContext);

  const longPressHandlers = useLongPress({ onLongPress: open });

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
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuContent>) {
  const { isDesktop } = React.useContext(ResponsiveContextMenuContext);

  if (isDesktop) {
    return (
      <ContextMenuContent className={className} {...props}>
        {children}
      </ContextMenuContent>
    );
  }

  return (
    <DrawerContent>
      <div className="pb-6">{children}</div>
    </DrawerContent>
  );
}

// ── Item ──

/** Menu item for the responsive context menu or drawer. */
function ResponsiveContextMenuItem({
  className,
  children,
  onClick,
  variant = 'default',
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuItem>) {
  const { isDesktop, close } = React.useContext(ResponsiveContextMenuContext);

  if (isDesktop) {
    return (
      <ContextMenuItem
        data-slot="context-menu-item"
        className={className}
        onClick={onClick}
        variant={variant}
        {...props}
      >
        {children}
      </ContextMenuItem>
    );
  }

  return (
    <button
      type="button"
      data-slot="context-menu-item"
      data-variant={variant}
      className={cn(
        'border-border flex w-full items-center gap-2 border-b px-4 py-3 text-left text-sm transition-colors',
        'active:bg-accent/50 min-h-[44px]',
        'last:border-b-0',
        variant === 'destructive' && 'text-destructive',
        className
      )}
      onClick={(e) => {
        onClick?.(e as unknown as React.MouseEvent<HTMLDivElement>);
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

export {
  ResponsiveContextMenu,
  ResponsiveContextMenuTrigger,
  ResponsiveContextMenuContent,
  ResponsiveContextMenuItem,
  ResponsiveContextMenuSeparator,
};
