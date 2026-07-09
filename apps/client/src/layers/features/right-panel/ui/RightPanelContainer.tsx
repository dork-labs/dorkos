import { useEffect, useRef, useState, Suspense } from 'react';
import { Panel, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels';
import { useRouterState } from '@tanstack/react-router';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/layers/shared/ui';
import {
  useAppStore,
  useIsMobile,
  useSlotContributions,
  useTransport,
} from '@/layers/shared/model';
import { PanelErrorBoundary } from './PanelErrorBoundary';
import { RightPanelHeader } from './RightPanelHeader';

/** CSS transition for the Panel's flex-grow during programmatic open/close. */
const PANEL_TRANSITION = 'flex-grow 300ms ease-in-out';
/** CSS transition for the resize handle indicator during open/close. */
const HANDLE_INDICATOR_TRANSITION = 'opacity 300ms ease-in-out';

/**
 * Shell-level right panel container.
 *
 * Renders inside the AppShell PanelGroup. On desktop the panel is always
 * present in the DOM when contributions exist — collapsed to zero width when
 * closed, expanded with a CSS flex-grow transition (200ms) when opened.
 * Transitions are disabled during manual resize drag and on initial mount to
 * avoid layout flash. On mobile (768px breakpoint), renders as a Sheet with
 * built-in slide animation.
 */
export function RightPanelContainer() {
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const activeTab = useAppStore((s) => s.activeRightPanelTab);
  const setActiveTab = useAppStore((s) => s.setActiveRightPanelTab);
  const isMobile = useIsMobile();
  const panelRef = useRef<ImperativePanelHandle>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Disable transitions on initial mount to prevent a flash when the
  // PanelGroup restores persisted layout — enable after first paint.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Subscribe to pathname so visibleWhen predicates re-evaluate on route changes
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // The active transport gates capability-scoped tabs (e.g. the web-only terminal).
  const transport = useTransport();

  // Get all right-panel contributions, sorted by priority
  const allContributions = useSlotContributions('right-panel');

  // Filter to only visible contributions, passing router + transport to each predicate
  const visibleContributions = allContributions.filter(
    (c) => !c.visibleWhen || c.visibleWhen({ pathname, transport })
  );

  // Auto-select first visible tab if active tab is not visible
  useEffect(() => {
    if (visibleContributions.length > 0) {
      const activeIsVisible = visibleContributions.some((c) => c.id === activeTab);
      if (!activeIsVisible) {
        setActiveTab(visibleContributions[0].id);
      }
    }
  }, [visibleContributions, activeTab, setActiveTab]);

  const shouldShow = rightPanelOpen && visibleContributions.length > 0;

  // Sync Panel collapsed/expanded state. The defaultSize prop handles the
  // initial render; this effect handles subsequent open/close toggles.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (shouldShow && panel.isCollapsed()) {
      panel.expand();
    } else if (!shouldShow && panel.isExpanded()) {
      panel.collapse();
    }
  }, [shouldShow]);

  // No contributions at all — remove panel from the DOM entirely
  if (visibleContributions.length === 0) return null;

  const activeContribution = visibleContributions.find((c) => c.id === activeTab);
  const ActiveComponent = activeContribution?.component;
  const ActiveHeaderActions = activeContribution?.headerActions;

  // Header + active content — rendered identically on desktop and mobile. The
  // container owns the shared header so the tab strip and close button can
  // never be lost, regardless of which panel is active.
  const panelInner = (
    <>
      <RightPanelHeader
        contributions={visibleContributions}
        actions={
          ActiveHeaderActions ? (
            <Suspense fallback={null}>
              <ActiveHeaderActions />
            </Suspense>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        <PanelErrorBoundary tabId={activeTab}>
          <Suspense fallback={null}>{ActiveComponent && <ActiveComponent />}</Suspense>
        </PanelErrorBoundary>
      </div>
    </>
  );

  // Mobile: render as Sheet (built-in slide animation)
  if (isMobile) {
    if (!shouldShow) return null;
    return (
      <Sheet open onOpenChange={(open) => !open && setRightPanelOpen(false)}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="bg-sidebar text-sidebar-foreground flex w-full flex-col gap-0 p-0 sm:max-w-full"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Panel</SheetTitle>
            <SheetDescription>Right panel content.</SheetDescription>
          </SheetHeader>
          {panelInner}
        </SheetContent>
      </Sheet>
    );
  }

  // Desktop: always-present collapsible panel with animated transitions.
  // Transitions are suppressed until after initial paint and during drag resize.
  const animate = mounted && !isDragging;

  return (
    <>
      <PanelResizeHandle
        className="group relative"
        style={{ width: 0, overflow: 'visible' }}
        disabled={!shouldShow}
        onDragging={setIsDragging}
      >
        <div
          className="absolute inset-y-0 -left-1 z-10 flex w-2 items-center justify-center"
          style={{
            opacity: shouldShow ? 1 : 0,
            pointerEvents: shouldShow ? 'auto' : 'none',
            ...(animate && { transition: HANDLE_INDICATOR_TRANSITION }),
          }}
        >
          <div className="group-hover:bg-ring/50 h-full w-px transition-colors duration-500" />
        </div>
      </PanelResizeHandle>
      <Panel
        ref={panelRef}
        id="right-panel"
        order={2}
        defaultSize={shouldShow ? 35 : 0}
        minSize={20}
        collapsible
        collapsedSize={0}
        onCollapse={() => setRightPanelOpen(false)}
        onExpand={() => {
          if (!rightPanelOpen) setRightPanelOpen(true);
        }}
        style={animate ? { transition: PANEL_TRANSITION } : undefined}
      >
        <div className="bg-sidebar text-sidebar-foreground flex h-full flex-col overflow-hidden border-l">
          {panelInner}
        </div>
      </Panel>
    </>
  );
}
