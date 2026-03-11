import * as React from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useIsMobile } from '../model';
import { cn } from '../lib/utils';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface ItemRegistration {
  value: string;
  label: string;
}

interface NavigationLayoutContextValue {
  value: string;
  onValueChange: (value: string) => void;
  isMobile: boolean;
  isDrilledIn: boolean;
  goBack: () => void;
  direction: 'forward' | 'backward';
  activeLabel: string;
  registerItem: (reg: ItemRegistration) => void;
  unregisterItem: (value: string) => void;
}

const NavigationLayoutContext = React.createContext<NavigationLayoutContextValue | undefined>(
  undefined
);

/** Read navigation layout context. Throws if used outside a `NavigationLayout`. */
function useNavigationLayout(): NavigationLayoutContextValue {
  const ctx = React.useContext(NavigationLayoutContext);
  if (!ctx) {
    throw new Error('useNavigationLayout must be used within a <NavigationLayout>');
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

interface NavigationLayoutProps {
  children: React.ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
}

/** Root container for sidebar navigation layout with desktop/mobile adaptivity. */
function NavigationLayout({ children, value, onValueChange, className }: NavigationLayoutProps) {
  const isMobile = useIsMobile();
  const [isDrilledIn, setIsDrilledIn] = React.useState(false);
  const [direction, setDirection] = React.useState<'forward' | 'backward'>('forward');
  // Use a ref for the items registry so labels persist even when sidebar
  // unmounts on mobile drill-in. A counter state triggers re-renders when
  // items register so activeLabel stays current.
  const itemsRef = React.useRef<Map<string, string>>(new Map());
  const [, setItemVersion] = React.useState(0);

  const registerItem = React.useCallback((reg: ItemRegistration) => {
    const prev = itemsRef.current.get(reg.value);
    if (prev !== reg.label) {
      itemsRef.current.set(reg.value, reg.label);
      setItemVersion((v) => v + 1);
    }
  }, []);

  const unregisterItem = React.useCallback((_val: string) => {
    // Intentionally a no-op: labels persist for back-button display
    // even after the sidebar unmounts on mobile drill-in.
  }, []);

  const activeLabel = itemsRef.current.get(value) ?? '';

  // Reset drill-in when viewport switches to desktop
  React.useEffect(() => {
    if (!isMobile) setIsDrilledIn(false);
  }, [isMobile]);

  const handleValueChange = React.useCallback(
    (newValue: string) => {
      setDirection('forward');
      onValueChange(newValue);
      if (isMobile) setIsDrilledIn(true);
    },
    [isMobile, onValueChange]
  );

  const goBack = React.useCallback(() => {
    setDirection('backward');
    setIsDrilledIn(false);
  }, []);

  const ctxValue = React.useMemo<NavigationLayoutContextValue>(
    () => ({
      value,
      onValueChange: handleValueChange,
      isMobile,
      isDrilledIn,
      goBack,
      direction,
      activeLabel,
      registerItem,
      unregisterItem,
    }),
    [value, handleValueChange, isMobile, isDrilledIn, goBack, direction, activeLabel, registerItem, unregisterItem]
  );

  return (
    <NavigationLayoutContext.Provider value={ctxValue}>
      <LayoutGroup>
        <div
          data-slot="navigation-layout"
          className={cn('flex flex-1 overflow-hidden', className)}
        >
          {children}
        </div>
      </LayoutGroup>
    </NavigationLayoutContext.Provider>
  );
}
NavigationLayout.displayName = 'NavigationLayout';

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

interface NavigationLayoutSidebarProps {
  children: React.ReactNode;
  className?: string;
}

/** Vertical sidebar (desktop) or list view (mobile). */
function NavigationLayoutSidebar({ children, className }: NavigationLayoutSidebarProps) {
  const { isMobile, isDrilledIn } = useNavigationLayout();
  const id = React.useId();
  const tabListRef = React.useRef<HTMLDivElement>(null);

  if (isMobile) {
    if (isDrilledIn) return null;
    return (
      <div
        data-slot="navigation-layout-sidebar"
        role="list"
        className={cn('flex-1 overflow-y-auto py-1', className)}
      >
        {children}
      </div>
    );
  }

  return (
    <NavigationLayoutSidebarKeyboardHandler containerRef={tabListRef} id={id}>
      <div
        ref={tabListRef}
        data-slot="navigation-layout-sidebar"
        role="tablist"
        aria-orientation="vertical"
        aria-label="Navigation"
        tabIndex={-1}
        className={cn('w-[180px] shrink-0 overflow-y-auto border-r py-2', className)}
      >
        {children}
      </div>
    </NavigationLayoutSidebarKeyboardHandler>
  );
}
NavigationLayoutSidebar.displayName = 'NavigationLayoutSidebar';

/** Keyboard handler wrapper for desktop sidebar tablist. */
function NavigationLayoutSidebarKeyboardHandler({
  children,
  containerRef,
  id,
}: {
  children: React.ReactNode;
  containerRef: React.RefObject<HTMLDivElement | null>;
  id: string;
}) {
  const { value, onValueChange } = useNavigationLayout();

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      const tabs = containerRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
      if (!tabs?.length) return;

      const tabArray = Array.from(tabs);
      const currentIndex = tabArray.findIndex((t) => t.getAttribute('data-value') === value);
      let nextIndex = currentIndex;

      switch (e.key) {
        case 'ArrowDown':
          nextIndex = (currentIndex + 1) % tabArray.length;
          e.preventDefault();
          break;
        case 'ArrowUp':
          nextIndex = (currentIndex - 1 + tabArray.length) % tabArray.length;
          e.preventDefault();
          break;
        case 'Home':
          nextIndex = 0;
          e.preventDefault();
          break;
        case 'End':
          nextIndex = tabArray.length - 1;
          e.preventDefault();
          break;
        default:
          return;
      }

      if (nextIndex !== currentIndex) {
        const nextValue = tabArray[nextIndex].getAttribute('data-value');
        if (nextValue) onValueChange(nextValue);
        tabArray[nextIndex].focus();
      }
    },
    [containerRef, value, onValueChange]
  );

  return (
    <div id={id} onKeyDown={handleKeyDown}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

interface NavigationLayoutItemProps {
  children: React.ReactNode;
  value: string;
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
}

/** Individual navigation item. Renders as a tab (desktop) or list item with drill-in (mobile). */
function NavigationLayoutItem({ children, value: itemValue, icon: Icon, className }: NavigationLayoutItemProps) {
  const { value, onValueChange, isMobile, registerItem, unregisterItem } = useNavigationLayout();
  const isActive = value === itemValue;
  const label = typeof children === 'string' ? children : '';

  // Register label for back-button display on mobile
  React.useEffect(() => {
    registerItem({ value: itemValue, label });
    return () => unregisterItem(itemValue);
  }, [itemValue, label, registerItem, unregisterItem]);

  if (isMobile) {
    return (
      <motion.button
        role="button"
        data-value={itemValue}
        onClick={() => onValueChange(itemValue)}
        whileTap={{ scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors',
          'hover:bg-muted/50 active:bg-muted min-h-[44px]',
          className
        )}
      >
        {Icon && <Icon className="text-muted-foreground size-(--size-icon-sm) shrink-0" />}
        <span className="flex-1">{children}</span>
        <ChevronRight className="text-muted-foreground/40 size-(--size-icon-sm) shrink-0" />
      </motion.button>
    );
  }

  return (
    <button
      role="tab"
      data-value={itemValue}
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      onClick={() => onValueChange(itemValue)}
      className={cn(
        'relative mx-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-150',
        isActive
          ? 'text-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
        className
      )}
    >
      {isActive && (
        <motion.div
          layoutId="nav-layout-active-pill"
          className="bg-muted absolute inset-0 rounded-md"
          transition={{ type: 'spring', stiffness: 280, damping: 32 }}
        />
      )}
      <span className="relative z-10 flex items-center gap-2">
        {Icon && <Icon className="size-(--size-icon-sm) shrink-0" />}
        {children}
      </span>
    </button>
  );
}
NavigationLayoutItem.displayName = 'NavigationLayoutItem';

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

interface NavigationLayoutContentProps {
  children: React.ReactNode;
  className?: string;
}

/** Content area that renders the active panel. */
function NavigationLayoutContent({ children, className }: NavigationLayoutContentProps) {
  const { isMobile, isDrilledIn, goBack, activeLabel, direction, value } = useNavigationLayout();

  if (isMobile) {
    if (!isDrilledIn) return null;

    const xOffset = direction === 'forward' ? 16 : -16;
    return (
      <div data-slot="navigation-layout-content" className={cn('flex flex-1 flex-col overflow-hidden', className)}>
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15 }}
          onClick={goBack}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 px-3 py-2 text-sm transition-colors"
          autoFocus
        >
          <ChevronLeft className="size-(--size-icon-sm)" />
          {activeLabel}
        </motion.button>
        <div className="flex-1 overflow-y-auto">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={value}
              initial={{ opacity: 0, x: xOffset }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -xOffset }}
              transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    );
  }

  return (
    <div
      data-slot="navigation-layout-content"
      className={cn('flex-1 min-w-0 overflow-y-auto', className)}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={value}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
NavigationLayoutContent.displayName = 'NavigationLayoutContent';

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface NavigationLayoutPanelProps {
  children: React.ReactNode;
  value: string;
  className?: string;
}

/** Panel content shown when its value matches the active navigation item. */
function NavigationLayoutPanel({ children, value: panelValue, className }: NavigationLayoutPanelProps) {
  const { value, isMobile } = useNavigationLayout();
  if (value !== panelValue) return null;

  if (isMobile) {
    return (
      <div data-slot="navigation-layout-panel" className={className}>
        {children}
      </div>
    );
  }

  return (
    <div
      role="tabpanel"
      aria-labelledby={`nav-item-${panelValue}`}
      data-slot="navigation-layout-panel"
      className={className}
    >
      {children}
    </div>
  );
}
NavigationLayoutPanel.displayName = 'NavigationLayoutPanel';

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  NavigationLayout,
  NavigationLayoutSidebar,
  NavigationLayoutItem,
  NavigationLayoutContent,
  NavigationLayoutPanel,
  useNavigationLayout,
};
