import { useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { Panel, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/layers/shared/ui';
import {
  useAppStore,
  useIsMobile,
  useSlotContributions,
  useTransport,
} from '@/layers/shared/model';
import { PanelErrorBoundary } from './PanelErrorBoundary';
import { RightPanelHeader, RIGHT_PANEL_PANEL_ID, rightPanelTabDomId } from './RightPanelHeader';
import { useRightPanelSizing } from '../model/use-right-panel-sizing';

/** CSS transition for the Panel's flex-grow during programmatic open/close. */
const PANEL_TRANSITION = 'flex-grow 300ms ease-in-out';
/** CSS transition for the resize handle indicator during open/close. */
const HANDLE_INDICATOR_TRANSITION = 'opacity 300ms ease-in-out';

/** How the container presents itself within its host shell. */
export interface RightPanelContainerProps {
  /**
   * The current route pathname, threaded into every tab's `visibleWhen`
   * predicate. The routed web/desktop shell (AppShell) supplies the live
   * TanStack Router pathname; the router-less Obsidian embed passes a constant
   * (`'/session'`) — the container never reaches for the router itself, so it
   * mounts safely in a shell with no `RouterProvider`.
   */
  pathname: string;
  /**
   * Presentation mode.
   *
   * - `'resizable'` (default): the desktop inset — a collapsible
   *   `react-resizable-panels` `Panel` that must live inside a `PanelGroup`;
   *   narrow viewports (`useIsMobile`) still fall back to the overlay Sheet.
   * - `'overlay'`: always the slide-over Sheet, regardless of width. The
   *   embed uses this — its pane is narrow and has no `PanelGroup`, so a
   *   side-by-side split would crowd the chat; an overlay degrades gracefully.
   */
  variant?: 'resizable' | 'overlay';
}

/**
 * Shell-level right panel container.
 *
 * In the routed shell (`variant='resizable'`) the panel is always present in
 * the DOM when contributions exist — collapsed to zero width when closed,
 * expanded with a CSS flex-grow transition (300ms) when opened. Transitions are
 * disabled during manual resize drag and on initial mount to avoid layout
 * flash. On narrow viewports (768px breakpoint) — and always under
 * `variant='overlay'` (the Obsidian embed) — it renders as a Sheet with
 * built-in slide animation instead.
 */
export function RightPanelContainer({ pathname, variant = 'resizable' }: RightPanelContainerProps) {
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const activeTab = useAppStore((s) => s.activeRightPanelTab);
  // View-only setter: auto-selecting a fallback tab must not overwrite the
  // per-agent stored preference (DOR-227). Explicit tab picks in the header use
  // the persisting `setActiveRightPanelTab`.
  const setActiveTabView = useAppStore((s) => s.setActiveRightPanelTabView);
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

  // The active transport gates capability-scoped tabs (e.g. the web-only terminal).
  const transport = useTransport();
  // The active agent + working directory let tabs scope visibility to a specific
  // agent or folder. `currentAgentId` is kept in sync by useSyncCurrentAgentId;
  // both are null when no agent/folder is resolved (the honest degraded value).
  const agentId = useAppStore((s) => s.currentAgentId);
  const cwd = useAppStore((s) => s.selectedCwd);
  // The agent the operator explicitly opened this session (Agent Hub). Unlike
  // `cwd`/`agentId` (ambient — the server's startup directory) this is
  // click-driven, so a tab can gate on a real selection instead of a default
  // nobody chose. Null until the first explicit open.
  const explicitAgentPath = useAppStore((s) => s.explicitAgentPath);

  // Get all right-panel contributions, sorted by priority
  const allContributions = useSlotContributions('right-panel');

  // Filter to only visible contributions, passing router + transport + agent
  // context to each predicate. Memoized so the auto-select effect below only
  // re-runs when the inputs actually change, not on every render.
  const visibleContributions = useMemo(
    () =>
      allContributions.filter(
        (c) =>
          !c.visibleWhen || c.visibleWhen({ pathname, transport, agentId, cwd, explicitAgentPath })
      ),
    [allContributions, pathname, transport, agentId, cwd, explicitAgentPath]
  );

  // Auto-select a default tab when the active tab is not visible. View-only: this
  // must not persist over the per-agent stored preference (DOR-227), so a tab
  // hidden by the current route/transport is restored once it returns.
  //
  // Contextual wins, global (Pulse) is the fallback — the Chrome sidePanel rule
  // (research: 20260720_context-aware-right-inspector-panels). Prefer the first
  // CONTEXTUAL (non-global) visible tab so the always-present Pulse never steals
  // the default from a contextual surface: /session keeps opening to Agent
  // Profile (or the persisted tab), while dashboard/activity/tasks/… — where no
  // contextual tab is visible — fall back to Pulse.
  useEffect(() => {
    if (visibleContributions.length > 0) {
      const activeIsVisible = visibleContributions.some((c) => c.id === activeTab);
      if (!activeIsVisible) {
        const firstContextual = visibleContributions.find((c) => !c.isGlobal);
        setActiveTabView((firstContextual ?? visibleContributions[0]).id);
      }
    }
  }, [visibleContributions, activeTab, setActiveTabView]);

  // The shell is never route-hidden — only its body varies (research:
  // 20260720_context-aware-right-inspector-panels). So "show" tracks the user's
  // open/close intent alone: even with zero visible contributions the panel
  // opens to an honest empty state rather than vanishing (which would strand the
  // always-present toggle pointing at nothing).
  const shouldShow = rightPanelOpen;

  // Live constraints: the pixel floor as a % of the measured group (DOR-388).
  const { minPct, defaultPct } = useRightPanelSizing();

  // Sync Panel collapsed/expanded state. The defaultSize prop handles the
  // initial render; this effect handles subsequent open/close toggles.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (shouldShow && panel.isCollapsed()) {
      // The default is a floor, not a fixed size: expand() restores a larger
      // remembered width, but without the floor it falls back to minSize when
      // none is remembered — and drag-to-close records ~minSize — so the panel
      // kept reopening squished (DOR-388).
      panel.expand(defaultPct);
    } else if (!shouldShow && panel.isExpanded()) {
      panel.collapse();
    }
  }, [shouldShow, defaultPct]);

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
      <div
        className="min-h-0 flex-1 overflow-hidden"
        {...(visibleContributions.length > 1 &&
        activeTab &&
        // A route/transport change can transiently leave activeTab pointing at
        // a filtered-out contribution (until the auto-select effect corrects
        // it) — never emit aria-labelledby for a tab that isn't rendered.
        visibleContributions.some((c) => c.id === activeTab)
          ? {
              id: RIGHT_PANEL_PANEL_ID,
              role: 'tabpanel',
              'aria-labelledby': rightPanelTabDomId(activeTab),
            }
          : {})}
      >
        <PanelErrorBoundary tabId={activeTab}>
          <Suspense fallback={null}>
            {/* Pulse is the always-present global tab, so there is always a
                visible contribution and the auto-select effect always resolves an
                active one — `ActiveComponent` is only briefly undefined for the
                single frame before that effect runs, where rendering nothing is
                correct. The Wave-1 "nothing to inspect" empty state is therefore
                unreachable and has been removed. */}
            {ActiveComponent ? <ActiveComponent /> : null}
          </Suspense>
        </PanelErrorBoundary>
      </div>
    </>
  );

  // Overlay: render as a slide-over Sheet instead of an inset split — always
  // under `variant='overlay'` (the narrow Obsidian embed, which has no
  // PanelGroup) and on mobile-width viewports in the routed shell.
  if (variant === 'overlay' || isMobile) {
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
        defaultSize={shouldShow ? defaultPct : 0}
        minSize={minPct}
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
