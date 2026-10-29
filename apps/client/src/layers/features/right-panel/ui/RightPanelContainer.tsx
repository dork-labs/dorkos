import { useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { Panel, type ImperativePanelHandle } from 'react-resizable-panels';
import {
  PaneResizeHandle,
  ResponsiveSheet,
  ResponsiveSheetContent,
  ResponsiveSheetHeader,
  ResponsiveSheetTitle,
  ResponsiveSheetDescription,
} from '@/layers/shared/ui';
import {
  useAppStore,
  useIsBelowDesktop,
  useIsMobile,
  useSlotContributions,
  useTransport,
  PanelResourceChrome,
  PanelResourceVisible,
  useVisualViewportBounds,
} from '@/layers/shared/model';
import { cn, WORK_PANEL_ID } from '@/layers/shared/lib';
import { effectivePlacement, placementShows } from '@dorkos/shared/mini-app-placement';
import { useConfig, usePanelTabPlacements } from '@/layers/entities/config';
import { WithheldExtensionsNotice } from '@/layers/entities/extension';
import { requestInbox } from '@/layers/entities/notifications';
import { GroupDmMemberPicker, useDirectMessagePanel } from '@/layers/features/direct-message';
import { PanelErrorBoundary } from './PanelErrorBoundary';
import { usePanelViews } from '../model/use-panel-views';
import { PanelViewsMenu } from './PanelViewsMenu';
import { MiniAppTabMenu } from './MiniAppTabMenu';
import { RightPanelHeader, RIGHT_PANEL_PANEL_ID, rightPanelTabDomId } from './RightPanelHeader';
import { useRightPanelSizing } from '../model/use-right-panel-sizing';
import { usePlacementHere } from '../model/use-placement-here';

/** The design system's entrance curve — fast start, gentle stop. */
const EASE_OUT = 'cubic-bezier(0, 0, 0.2, 1)';
/** The design system's exit curve — gentle start, fast finish. */
const EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)';

/**
 * The CSS transition for one animated property, curved by direction.
 *
 * The panel arrives on `ease-out` and leaves on `ease-in`, per the easing
 * table. Both used to be a single `ease-in-out`, which starts slowly in either
 * direction — so the widest moving surface in the app looked like it hesitated
 * before it moved.
 */
function panelTransition(property: 'flex-grow' | 'opacity', opening: boolean): string {
  return `${property} 300ms ${opening ? EASE_OUT : EASE_IN}`;
}

/**
 * Right-panel tabs measured at 390×844 with content short enough that a
 * full-height mobile sheet leaves the rest of the screen empty (DOR-1753,
 * finding 7.8) — Pulse's content ends around y=250, Files' six rows around
 * y=240. The sheet sizes to content for these two only.
 *
 * Every other tab keeps the full-height sheet on purpose, not by omission:
 * Terminal and Canvas are built to fill whatever height they are given (an
 * `h-auto` ancestor would hand a terminal emulator nothing to size against),
 * and Room/Profile/Session were never measured, so capping them on a guess
 * risks silently squashing a tab nobody checked. Widening this set needs the
 * same measurement this comment cites, not an assumption.
 */
const CONTENT_SIZED_MOBILE_TABS = new Set(['pulse', 'files']);

/**
 * Keep the sheet's opening focus on the panel body, never on a tab.
 *
 * The sheet's default focuses its first control, the first tab, which then
 * opens wearing its focus ring and tooltip. Show work and Watch open the Work
 * tab to read a turn, so focus goes to the body instead, and stays on a turn
 * the Work tab already focused. Tab still starts at the tabs (DOR-3075).
 */
function focusPanelBody(event: Event): void {
  event.preventDefault();
  const body = document.getElementById(RIGHT_PANEL_PANEL_ID);
  if (body && !body.contains(document.activeElement)) body.focus({ preventScroll: true });
}

/** How the container presents itself within its host shell. */
export interface RightPanelContainerProps {
  pathname: string;
  /** Whether the open channel is addressed through a connected community. */
  isRemoteCommunityRoom?: boolean;
}

/**
 * Shell-level right panel container.
 */
export function RightPanelContainer({
  pathname,
  isRemoteCommunityRoom = false,
}: RightPanelContainerProps) {
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useAppStore((s) => s.setRightPanelOpen);
  const activeTab = useAppStore((s) => s.activeRightPanelTab);
  // View-only setter: auto-selecting a fallback tab must not overwrite the
  // per-agent stored preference (DOR-227). Explicit tab picks in the header use
  // the persisting `setActiveRightPanelTab`.
  const setActiveTabView = useAppStore((s) => s.setActiveRightPanelTabView);
  const overlayOnly = useIsBelowDesktop();
  const isPhone = useIsMobile();
  const viewport = useVisualViewportBounds();
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
  // The agent the operator explicitly opened this session (the profile). Unlike
  // `cwd`/`agentId` (ambient — the server's startup directory) this is
  // click-driven, so a tab can gate on a real selection instead of a default
  // nobody chose. Null until the first explicit open.
  const explicitAgentPath = useAppStore((s) => s.explicitAgentPath);

  // The DM the panel sits beside, while the DM view is on (DOR-3075): its tabs
  // match a session's, and a group DM's follow the member picked at the top.
  const dmPanel = useDirectMessagePanel();
  const dmKind = dmPanel?.kind ?? null;
  const dmShowSessions = dmPanel?.showSessions ?? false;
  const directMessage = useMemo(
    () => (dmKind === null ? null : { kind: dmKind, showSessions: dmShowSessions }),
    [dmKind, dmShowSessions]
  );

  // Get all right-panel contributions, sorted by priority
  const allContributions = useSlotContributions('right-panel');

  // Filter to only visible contributions, passing route + transport + agent
  // context to each predicate. Memoized so the auto-select effect below only
  // re-runs when the inputs actually change, not on every render.
  const routeContributions = useMemo(
    () =>
      allContributions.filter(
        (c) =>
          !c.visibleWhen ||
          c.visibleWhen({
            pathname,
            transport,
            agentId,
            cwd,
            explicitAgentPath,
            isRemoteCommunityRoom,
            directMessage,
          })
      ),
    [
      allContributions,
      pathname,
      transport,
      agentId,
      cwd,
      explicitAgentPath,
      isRemoteCommunityRoom,
      directMessage,
    ]
  );

  // Mini-app tabs also follow their placement rules (spec `mini-app-placement`).
  // While "here" is still resolving, the last answer stands in, so an open
  // mini-app tab is not dropped for a frame and swapped for another tab.
  const hereState = usePlacementHere(pathname, isRemoteCommunityRoom);
  const here = hereState.status === 'ready' ? hereState.here : hereState.last;
  const savedPlacements = usePanelTabPlacements();
  const configLoaded = useConfig().data !== undefined;
  // A Map keeps the LAST entry per tab, the same rule as `savedPlacementFor`.
  const savedByTab = useMemo(
    () => new Map(savedPlacements.map((entry) => [entry.tab, entry])),
    [savedPlacements]
  );
  const { visibleContributions: placedContributions, hiddenMiniAppTabs } = useMemo(() => {
    const visible: typeof routeContributions = [];
    const hidden: typeof routeContributions = [];
    for (const c of routeContributions) {
      if (!c.extensionId) visible.push(c);
      else if (
        here &&
        placementShows(effectivePlacement(savedByTab.get(c.id), c.declaredPlacement), here)
      )
        visible.push(c);
      else hidden.push(c);
    }
    return { visibleContributions: visible, hiddenMiniAppTabs: hidden };
  }, [routeContributions, here, savedByTab]);

  const views = usePanelViews(placedContributions, pathname);
  const visibleContributions = views.visible;
  const sessionId = useAppStore((s) => s.sessionId);
  const terminalScope = `${sessionId ?? ''}:${cwd}`;

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
    // Never re-pick while "here" is resolving: the pick would overwrite the tab
    // the person was on, and nothing would put it back.
    if (hereState.status === 'pending') return;
    if (visibleContributions.length > 0) {
      const activeIsVisible = visibleContributions.some((c) => c.category === activeTab);
      if (!activeIsVisible) {
        const firstContextual = visibleContributions.find((c) => !c.isGlobal);
        setActiveTabView((firstContextual ?? visibleContributions[0]).category);
      }
    }
  }, [visibleContributions, activeTab, setActiveTabView, hereState.status]);

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

  const activeContribution = views.available.find(
    (c) => c.id === activeTab && visibleContributions.some((view) => view.category === c.id)
  );
  const terminalContribution = views.available.find((c) => c.id === 'terminal');
  const TerminalComponent = terminalContribution?.component;
  const terminalRetained = views.terminal !== null || activeTab === 'terminal';
  const ActiveComponent = activeContribution?.component;
  const ActiveHeaderActions = activeContribution?.headerActions;

  // Header + active content — rendered identically on desktop and mobile. The
  // container owns the shared header so the tab strip and close button can
  // never be lost, regardless of which panel is active.
  const panelInner = (
    <>
      <RightPanelHeader
        contributions={visibleContributions}
        activeId={views.activeId}
        onActivate={views.activate}
        onCloseView={views.closeView}
        actions={
          <>
            <PanelViewsMenu
              views={views.allViews}
              activeId={views.activeId}
              onActivate={views.activate}
              onCreateBrowser={views.createBrowser}
              onCreateDocument={views.createDocument}
              onRemoveDocument={views.removeDocument}
              onPinDocument={views.pinDocument}
              documentPinned={views.documentPinned}
              onCreateTerminal={views.createTerminal}
              onStopTerminal={
                activeTab === 'terminal' && views.terminal?.activeId
                  ? () => views.terminal?.stop(views.terminal.activeId!, 'pointer')
                  : undefined
              }
            />
            {ActiveHeaderActions ? (
              <Suspense fallback={null}>
                <ActiveHeaderActions />
              </Suspense>
            ) : null}
            {/* Only once "here" has settled (a pick made while it resolves
                would be written for the place just left) and config has
                loaded (a write needs the whole saved list to change one). */}
            {hereState.status === 'ready' && configLoaded && (
              <MiniAppTabMenu
                active={activeContribution?.extensionId ? activeContribution : null}
                hidden={hiddenMiniAppTabs}
                here={hereState.here}
                saved={savedByTab}
              />
            )}
          </>
        }
      />
      {dmPanel?.kind === 'group' && rightPanelOpen && (
        <GroupDmMemberPicker members={dmPanel.members} />
      )}
      {/* A mini app tab held back because its code changed says so (DOR-3068). */}
      <WithheldExtensionsNotice
        slot="right-panel"
        onReview={() => requestInbox()}
        className="border-b px-2 py-1.5"
      />
      <div
        className="min-h-0 flex-1 overflow-hidden outline-none"
        // The Work tab's body takes focus when Show work or Watch opens it.
        {...(activeTab === WORK_PANEL_ID ? { tabIndex: -1 } : {})}
        {...(views.activeId &&
        // A route/transport change can transiently leave activeTab pointing at
        // a filtered-out contribution (until the auto-select effect corrects
        // it) — never emit aria-labelledby for a tab that isn't rendered.
        visibleContributions.some((c) => c.category === activeTab)
          ? {
              id: RIGHT_PANEL_PANEL_ID,
              role: 'tabpanel',
              'aria-labelledby': rightPanelTabDomId(views.activeId!),
            }
          : {})}
      >
        <PanelErrorBoundary tabId={activeTab}>
          <Suspense fallback={null}>
            {/* Closing a view hides its presenter; retained terminals keep their resource owner. */}
            <PanelResourceChrome value>
              {rightPanelOpen && activeTab !== 'terminal' && ActiveComponent ? (
                <ActiveComponent />
              ) : null}
              {TerminalComponent && terminalRetained && (
                <div
                  key={terminalScope}
                  hidden={activeTab !== 'terminal' || !rightPanelOpen || !activeContribution}
                  className="h-full"
                >
                  <PanelResourceVisible
                    value={activeTab === 'terminal' && rightPanelOpen && !!activeContribution}
                  >
                    <PanelErrorBoundary tabId={activeTab}>
                      <TerminalComponent />
                    </PanelErrorBoundary>
                  </PanelResourceVisible>
                </div>
              )}
              {!activeContribution && (
                <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-sm">
                  Add a view to this panel.
                </div>
              )}
            </PanelResourceChrome>
          </Suspense>
        </PanelErrorBoundary>
      </div>
    </>
  );

  if (overlayOnly) {
    if (!shouldShow) return null;
    return (
      <ResponsiveSheet open onOpenChange={(open) => !open && setRightPanelOpen(false)}>
        <ResponsiveSheetContent
          showCloseButton={false}
          {...(activeTab === WORK_PANEL_ID ? { onOpenAutoFocus: focusPanelBody } : {})}
          style={{
            top: viewport.top,
            bottom: 'auto',
            height: viewport.height,
            maxHeight: viewport.height,
          }}
          className={cn(
            'bg-sidebar text-sidebar-foreground flex w-full flex-col gap-0 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]',
            isPhone && 'sm:max-w-full',
            isPhone &&
              activeTab &&
              CONTENT_SIZED_MOBILE_TABS.has(activeTab) &&
              // `!` because the base `side="right"` classes already claim
              // `inset-y-0` (top AND bottom) and `h-full`. Without
              // `!important` the winner between that `bottom: 0` and this
              // `bottom: auto` depends on Tailwind's internal utility order,
              // not on source order — a plain override here would be a coin
              // flip in production even though it reads correctly in the
              // diff. `max-h-dvh` is the safety net if a short tab's content
              // ever grows past the viewport; it scrolls instead of
              // overflowing off-screen.
              '!bottom-auto !h-auto max-h-dvh overflow-y-auto'
          )}
        >
          <ResponsiveSheetHeader className="sr-only">
            <ResponsiveSheetTitle>Panel</ResponsiveSheetTitle>
            <ResponsiveSheetDescription>Right panel content.</ResponsiveSheetDescription>
          </ResponsiveSheetHeader>
          {panelInner}
        </ResponsiveSheetContent>
      </ResponsiveSheet>
    );
  }

  // Desktop: always-present collapsible panel with animated transitions.
  // Transitions are suppressed until after initial paint and during drag resize.
  const animate = mounted && !isDragging;

  return (
    <>
      <PaneResizeHandle
        aria-label="Resize right panel"
        disabled={!shouldShow}
        onDragging={setIsDragging}
        gripStyle={{
          opacity: shouldShow ? 1 : 0,
          pointerEvents: shouldShow ? 'auto' : 'none',
          ...(animate && { transition: panelTransition('opacity', shouldShow) }),
        }}
      />
      <Panel
        ref={panelRef}
        id="right-panel"
        order={2}
        defaultSize={shouldShow ? defaultPct : 0}
        minSize={minPct}
        collapsible
        collapsedSize={0}
        // Only once we are past the first paint. `PanelGroup` restores its own
        // saved split on mount, and a restored `[100, 0]` fires this — which is
        // the group remembering a width, not a person closing the panel. Before
        // the guard, a link that asked for the panel had it reported shut on the
        // frame it opened, and the expand effect above then saw nothing to do.
        onCollapse={() => {
          if (mounted) setRightPanelOpen(false);
        }}
        onExpand={() => {
          if (!rightPanelOpen) setRightPanelOpen(true);
        }}
        style={animate ? { transition: panelTransition('flex-grow', shouldShow) } : undefined}
      >
        <div
          inert={!shouldShow}
          className="bg-sidebar text-sidebar-foreground flex h-full flex-col overflow-hidden border-l"
        >
          {panelInner}
        </div>
      </Panel>
    </>
  );
}
