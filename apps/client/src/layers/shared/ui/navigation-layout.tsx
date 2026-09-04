import * as React from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'motion/react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useIsMobile } from '../model';
import { cn } from '../lib/utils';
import { useResponsiveDialogOptional } from './responsive-dialog';

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
  /**
   * Prefix for every id this layout mints, so two `NavigationLayout`s on one
   * screen cannot collide. The ids used to be global (`nav-item-general`), and
   * an `aria-controls` that names two elements names neither.
   */
  idScope: string;
  /** True when a NavigationLayoutDialogHeader is mounted. */
  hasDialogHeader: boolean;
  /** @internal Called by NavigationLayoutDialogHeader on mount. */
  registerDialogHeader: () => () => void;
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

/**
 * Root container for sidebar navigation layout with desktop/mobile adaptivity.
 * Renders as a flex-column to support an optional dialog header above the sidebar + content row.
 */
function NavigationLayout({ children, value, onValueChange, className }: NavigationLayoutProps) {
  const isMobile = useIsMobile();
  const idScope = React.useId();
  const [drilledIn, setIsDrilledIn] = React.useState(false);
  // Drill-in is a mobile idea, so a desktop viewport simply is not drilled in —
  // derived rather than reset from an effect, which used to leave one render
  // showing a drilled-in desktop sidebar.
  const isDrilledIn = isMobile && drilledIn;
  const [direction, setDirection] = React.useState<'forward' | 'backward'>('forward');
  const [hasDialogHeader, setHasDialogHeader] = React.useState(false);
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

  const registerDialogHeader = React.useCallback(() => {
    setHasDialogHeader(true);
    return () => setHasDialogHeader(false);
  }, []);

  // eslint-disable-next-line react-hooks/refs -- itemsRef is synchronized via itemVersion state counter
  const activeLabel = itemsRef.current.get(value) ?? '';

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
      idScope,
      hasDialogHeader,
      registerDialogHeader,
    }),
    [
      value,
      handleValueChange,
      isMobile,
      isDrilledIn,
      goBack,
      direction,
      activeLabel,
      registerItem,
      unregisterItem,
      idScope,
      hasDialogHeader,
      registerDialogHeader,
    ]
  );

  return (
    <NavigationLayoutContext.Provider value={ctxValue}>
      {/* Scoped, so two layouts on one screen do not share the active pill's
          `layoutId` and animate it between each other. */}
      <LayoutGroup id={idScope}>
        <div
          data-slot="navigation-layout"
          className={cn('flex flex-1 flex-col overflow-hidden', className)}
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
  const tabListRef = React.useRef<HTMLDivElement>(null);
  const handleKeyDown = useTabListKeys(tabListRef);

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

  // The arrow keys are handled ON the tablist, not on a wrapper around it. The
  // wrapper was a `role="toolbar"` — a composite widget holding a composite
  // widget, which assistive tech has no model for, and which the tablist did
  // not need in order to hear a key.
  return (
    <div
      ref={tabListRef}
      data-slot="navigation-layout-sidebar"
      role="tablist"
      aria-orientation="vertical"
      aria-label="Navigation"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={cn('h-full w-[180px] shrink-0 overflow-y-auto border-r py-2', className)}
    >
      {children}
    </div>
  );
}
NavigationLayoutSidebar.displayName = 'NavigationLayoutSidebar';

/**
 * Arrow / Home / End across the sidebar's tabs, WAI-ARIA automatic activation.
 *
 * @param containerRef - The element holding the tabs.
 */
function useTabListKeys(containerRef: React.RefObject<HTMLDivElement | null>) {
  const { value, onValueChange } = useNavigationLayout();

  return React.useCallback(
    (e: React.KeyboardEvent) => {
      const tabs = containerRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
      if (!tabs?.length) return;

      const tabArray = Array.from(tabs);
      const currentIndex = tabArray.findIndex((t) => t.getAttribute('data-value') === value);
      let nextIndex: number;

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
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

interface NavigationLayoutSectionHeaderProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * A group label inside the sidebar/list — the quiet heading that names a run of
 * related items ("Access & privacy"). It is `role="presentation"`, not a tab or
 * list item, so the tablist's arrow-key navigation walks straight past it and it
 * never becomes a selectable destination. Renders the same on desktop and in the
 * mobile drill-in list, where it reads as a plain list section header.
 */
function NavigationLayoutSectionHeader({
  children,
  className,
}: NavigationLayoutSectionHeaderProps) {
  return (
    <div
      role="presentation"
      data-slot="navigation-layout-section-header"
      className={cn(
        'text-muted-foreground/70 text-2xs px-4 pt-3 pb-1 font-medium tracking-wide uppercase select-none md:px-3',
        className
      )}
    >
      {children}
    </div>
  );
}
NavigationLayoutSectionHeader.displayName = 'NavigationLayoutSectionHeader';

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
function NavigationLayoutItem({
  children,
  value: itemValue,
  icon: Icon,
  className,
}: NavigationLayoutItemProps) {
  const { value, onValueChange, isMobile, idScope, registerItem, unregisterItem } =
    useNavigationLayout();
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
      id={`${idScope}item-${itemValue}`}
      data-value={itemValue}
      aria-selected={isActive}
      aria-controls={`${idScope}panel-${itemValue}`}
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
  const { isMobile, isDrilledIn, goBack, activeLabel, direction, value, hasDialogHeader } =
    useNavigationLayout();

  if (isMobile) {
    if (!isDrilledIn) return null;

    const xOffset = direction === 'forward' ? 16 : -16;
    return (
      <div
        data-slot="navigation-layout-content"
        className={cn('flex flex-1 flex-col overflow-hidden', className)}
      >
        {/* Show built-in back button only when no dialog header handles navigation */}
        {!hasDialogHeader && (
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15 }}
            onClick={goBack}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 px-3 py-2 text-sm transition-colors"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- Focus back button on sub-view navigation for keyboard accessibility
            autoFocus
          >
            <ChevronLeft className="size-(--size-icon-sm)" />
            {activeLabel}
          </motion.button>
        )}
        <div className="flex-1 overflow-y-auto">
          {/* This exiting-wrapper crossfade is only safe because mobile panels
              render no `id`/`role` — adding either here recreates the DOR-693
              duplicate-panel window the desktop branch below was rebuilt to
              eliminate. */}
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

  // One panel at a time, deliberately.
  //
  // This used to be an `AnimatePresence mode="popLayout"` crossfade, and the
  // crossfade never worked: `children` is the full set of `NavigationLayoutPanel`
  // elements, each of which decides for itself whether to render by reading
  // `value` off context. The exiting wrapper stays mounted in this subtree, so a
  // context change re-renders it too — it dropped the panel it was supposed to be
  // fading OUT and drew the incoming one instead. Both halves showed the same
  // content, so there was nothing to cross-fade, and for the ~150ms of the exit
  // the dialog held two `role="tabpanel"` elements carrying the same DOM id.
  // Duplicate ids are invalid HTML, and they make the tab's `aria-controls`
  // ambiguous: a screen reader is offered two panels for one tab.
  //
  // A keyed plain div matches what users actually saw: the two superimposed
  // copies composited to near-opaque, so the switch always read as instant.
  // React swaps the subtree in one commit, so the second panel never exists.
  return (
    <div
      data-slot="navigation-layout-content"
      className={cn('relative min-w-0 flex-1 overflow-y-auto', className)}
    >
      <div key={value}>{children}</div>
    </div>
  );
}
NavigationLayoutContent.displayName = 'NavigationLayoutContent';

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

interface NavigationLayoutBodyProps {
  children: React.ReactNode;
  className?: string;
}

/** Flex-row wrapper for sidebar + content. Required when using NavigationLayoutDialogHeader. */
function NavigationLayoutBody({ children, className }: NavigationLayoutBodyProps) {
  return (
    <div
      data-slot="navigation-layout-body"
      className={cn('flex flex-1 overflow-hidden', className)}
    >
      {children}
    </div>
  );
}
NavigationLayoutBody.displayName = 'NavigationLayoutBody';

// ---------------------------------------------------------------------------
// Dialog Header
// ---------------------------------------------------------------------------

interface NavigationLayoutDialogHeaderProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Navigation-aware dialog header. Replaces ResponsiveDialogHeader inside a NavigationLayout.
 *
 * - Desktop / mobile list view: renders children (title) as a standard header.
 * - Mobile drilled in: renders a back button with the active section label.
 */
function NavigationLayoutDialogHeader({ children, className }: NavigationLayoutDialogHeaderProps) {
  const { isMobile, isDrilledIn, goBack, activeLabel, registerDialogHeader } =
    useNavigationLayout();
  // Optional: TabbedDialog nests this inside a ResponsiveDialog, but the unit
  // tests for this component render it standalone. Undefined here just means
  // "no fullscreen toggle to clear" — the same as the outcome today.
  const responsiveDialog = useResponsiveDialogOptional();

  // Register so NavigationLayoutContent knows to hide its built-in back button
  React.useLayoutEffect(() => {
    return registerDialogHeader();
  }, [registerDialogHeader]);

  if (isMobile && isDrilledIn) {
    return (
      <div
        data-slot="navigation-layout-dialog-header"
        className={cn('flex items-center border-b', className)}
      >
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15 }}
          onClick={goBack}
          className="text-muted-foreground hover:text-foreground flex flex-1 items-center gap-1 px-3 py-3 text-sm font-medium transition-colors"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- Focus back button in dialog header for keyboard accessibility
          autoFocus
        >
          <ChevronLeft className="size-(--size-icon-sm)" />
          {activeLabel}
        </motion.button>
      </div>
    );
  }

  // The dialog's own close button (and, when mounted, the
  // ResponsiveDialogFullscreenToggle) share DialogContent's single grid
  // column with this header, so a long title runs underneath either one
  // without a matching reservation — the same overlap ResponsiveDialogHeader
  // guards against. TabbedDialog is the only caller and it always mounts the
  // toggle, so this reserves `pr-20` there in practice.
  const isDesktop = responsiveDialog?.isDesktop ?? false;
  const hasFullscreenToggle = responsiveDialog?.hasFullscreenToggle ?? false;

  return (
    <div
      data-slot="navigation-layout-dialog-header"
      className={cn(
        'space-y-0 border-b px-4 py-3',
        isDesktop && (hasFullscreenToggle ? 'pr-20' : 'pr-14'),
        className
      )}
    >
      {children}
    </div>
  );
}
NavigationLayoutDialogHeader.displayName = 'NavigationLayoutDialogHeader';

// ---------------------------------------------------------------------------
// Panel Header
// ---------------------------------------------------------------------------

interface NavigationLayoutPanelHeaderProps {
  children: React.ReactNode;
  actions?: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
}

/**
 * Panel header with desktop/mobile awareness.
 * Desktop: renders title + optional actions + optional description subtitle.
 * Mobile: hides title (shown in back button), renders actions only; description is hidden.
 */
function NavigationLayoutPanelHeader({
  children,
  actions,
  description,
  className,
}: NavigationLayoutPanelHeaderProps) {
  const { isMobile } = useNavigationLayout();

  // Mobile: title already shown in back button — only render actions if present
  if (isMobile) {
    if (!actions) return null;
    return <div className={cn('flex items-center justify-end', className)}>{actions}</div>;
  }

  // Desktop: title + optional actions + optional description subtitle
  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex items-center justify-between">
        <h3 className="text-foreground text-sm font-semibold">{children}</h3>
        {actions}
      </div>
      {description && (
        <p className="text-muted-foreground text-xs leading-relaxed">{description}</p>
      )}
    </div>
  );
}
NavigationLayoutPanelHeader.displayName = 'NavigationLayoutPanelHeader';

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface NavigationLayoutPanelProps {
  children: React.ReactNode;
  value: string;
  className?: string;
}

/** Panel content shown when its value matches the active navigation item. */
function NavigationLayoutPanel({
  children,
  value: panelValue,
  className,
}: NavigationLayoutPanelProps) {
  const { value, isMobile, idScope, activeLabel } = useNavigationLayout();
  if (value !== panelValue) return null;

  if (isMobile) {
    return (
      // The drill-in panel renders no heading of its own (the title lives in
      // the drawer's back button), so this label is the one name assistive
      // tech gets for the region (DOR-918 review).
      <div data-slot="navigation-layout-panel" aria-label={activeLabel} className={className}>
        {children}
      </div>
    );
  }

  return (
    <div
      role="tabpanel"
      id={`${idScope}panel-${panelValue}`}
      aria-labelledby={`${idScope}item-${panelValue}`}
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
  NavigationLayoutBody,
  NavigationLayoutSidebar,
  NavigationLayoutSectionHeader,
  NavigationLayoutItem,
  NavigationLayoutContent,
  NavigationLayoutPanel,
  NavigationLayoutPanelHeader,
  NavigationLayoutDialogHeader,
  useNavigationLayout,
};
