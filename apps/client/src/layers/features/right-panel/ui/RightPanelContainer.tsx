import { useEffect, Suspense } from 'react';
import { Panel, PanelResizeHandle } from 'react-resizable-panels';
import { useRouterState } from '@tanstack/react-router';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/layers/shared/ui';
import { useAppStore, useIsMobile, useSlotContributions } from '@/layers/shared/model';
import { RightPanelTabBar } from './RightPanelTabBar';
import { PanelErrorBoundary } from './PanelErrorBoundary';

/**
 * Shell-level right panel container.
 *
 * Renders inside the AppShell PanelGroup. Returns null when the panel is closed
 * or no contributions are visible. On desktop, renders a PanelResizeHandle +
 * resizable Panel. On mobile (768px breakpoint), renders a Sheet.
 */
export function RightPanelContainer() {
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const activeTab = useAppStore((s) => s.activeRightPanelTab);
  const setActiveTab = useAppStore((s) => s.setActiveRightPanelTab);
  const isMobile = useIsMobile();

  // Subscribe to pathname so visibleWhen predicates re-evaluate on route changes
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Get all right-panel contributions, sorted by priority
  const allContributions = useSlotContributions('right-panel');

  // Filter to only visible contributions, passing router state to each predicate
  const visibleContributions = allContributions.filter(
    (c) => !c.visibleWhen || c.visibleWhen({ pathname })
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

  if (!rightPanelOpen || visibleContributions.length === 0) return null;

  const ActiveComponent = visibleContributions.find((c) => c.id === activeTab)?.component;

  // Mobile: render as Sheet (matching existing canvas mobile pattern)
  if (isMobile) {
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
          <PanelErrorBoundary tabId={activeTab}>
            <Suspense fallback={null}>{ActiveComponent && <ActiveComponent />}</Suspense>
          </PanelErrorBoundary>
        </SheetContent>
      </Sheet>
    );
  }

  // Desktop: resizable panel with resize handle
  return (
    <>
      <PanelResizeHandle className="group relative flex w-2 items-center justify-center">
        <div className="bg-border group-hover:bg-ring h-full w-px transition-colors" />
      </PanelResizeHandle>
      <Panel
        id="right-panel"
        order={2}
        defaultSize={35}
        minSize={20}
        collapsible
        onCollapse={() => setRightPanelOpen(false)}
      >
        <div className="bg-sidebar text-sidebar-foreground flex h-full flex-col overflow-hidden rounded-lg border">
          <div className="flex-1 overflow-hidden">
            <PanelErrorBoundary tabId={activeTab}>
              <Suspense fallback={null}>{ActiveComponent && <ActiveComponent />}</Suspense>
            </PanelErrorBoundary>
          </div>
        </div>
      </Panel>
    </>
  );
}
