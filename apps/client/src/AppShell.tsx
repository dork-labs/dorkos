import { useEffect, useState, useCallback, Suspense } from 'react';
import { Outlet, useRouterState } from '@tanstack/react-router';
import type { SessionOrigin } from '@dorkos/shared/types';
import {
  useAppStore,
  useFavicon,
  useDocumentTitle,
  useSlotContributions,
} from '@/layers/shared/model';
import { useElectronNavigate } from './app/use-electron-navigate';
import { TitlebarDragStrip } from './app/TitlebarDragStrip';
import { SidebarBodyErrorBoundary } from './app/SidebarBodyErrorBoundary';
import { getAgentDisplayName, cn } from '@/layers/shared/lib';
import {
  useSessionId,
  useDefaultCwd,
  useDirectoryState,
  useGlobalSessionStream,
  useSessionOrigin,
} from '@/layers/entities/session';
import { useCurrentAgent, useAgentVisual } from '@/layers/entities/agent';
import { useCommandsSync } from '@/layers/entities/command';
import { useBindingsSync } from '@/layers/entities/binding';
import { useRelayAdaptersSync } from '@/layers/entities/relay';
import { motion, AnimatePresence, MotionConfig } from 'motion/react';
import { DialogHost } from '@/layers/widgets/app-layout';
import { AppBannerSlot, useAppBanners } from '@/layers/widgets/app-banner';
import { usePulseFreshness } from '@/layers/widgets/pulse';
import { SidebarFooterBar } from '@/layers/features/session-list';
import { DashboardSidebar } from '@/layers/features/dashboard-sidebar';
import {
  useOnboarding,
  useOnboardingOverlayVisible,
  OnboardingFlow,
  ProgressCard,
} from '@/layers/features/onboarding';
import { renderRuntimeConnect } from '@/layers/features/runtime-connect';
import {
  SessionHeader,
  DashboardHeader,
  AgentsHeader,
  ActivityHeader,
  TasksHeader,
  MarketplaceHeader,
  MarketplaceSourcesHeader,
} from '@/layers/features/top-nav';
import {
  Toaster,
  TooltipProvider,
  Separator,
  Sidebar,
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
  SidebarFooter,
  SidebarRail,
} from '@/layers/shared/ui';
import { CommandPaletteDialog } from '@/layers/features/command-palette';
import { CreateAgentDialog } from '@/layers/features/agent-creation';
import { ImportProjectsDialog } from '@/layers/features/mesh';
import { PipHost } from '@/layers/features/pip-panel';
import { TourHost } from '@/layers/features/tours';
import { ShortcutsPanel, useShortcutsPanel } from '@/layers/features/shortcuts';
import { PanelGroup, Panel } from 'react-resizable-panels';
import {
  RightPanelContainer,
  RightPanelToggle,
  useRightPanelPersistence,
  useRightPanelShortcut,
  useAgentProfileShortcut,
  RIGHT_PANEL_GROUP_ID,
} from '@/layers/features/right-panel';

// ── Private slot types ────────────────────────────────────────

interface SidebarSlot {
  /** Stable key for AnimatePresence — triggers transition on change */
  key: string;
  /** The sidebar body component to render */
  body: React.ReactNode;
  /** Slide direction: 1 = slide in from right (drilling in), -1 = slide in from left (backing out) */
  direction: 1 | -1;
}

interface HeaderSlot {
  /** Stable key for AnimatePresence — triggers cross-fade on route change */
  key: string;
  /** The header content to render between SidebarTrigger and edge */
  content: React.ReactNode;
  /** Optional colored border style for the session route */
  borderStyle: React.CSSProperties | undefined;
}

// ── Private slot hooks ────────────────────────────────────────

/**
 * Returns the sidebar body component for the current route.
 *
 * A registered `sidebar.body` contribution whose `visibleWhen(pathname)` matches
 * takes over the body wholesale (highest priority wins) — this is how the
 * marketplace facet panel replaces the roster on `/marketplace`. When nothing
 * matches, the built-in behavior applies: the Dashboard sidebar (the agent
 * roster) is the default and persists across every route, including `/session`.
 * The right-panel inspector — not a sidebar drill-in — now carries per-session
 * context, so the roster never gets swapped out from under the operator. The
 * surrounding chrome (trigger, footer, rail) never swaps — only this body does.
 */
function useSidebarSlot(): SidebarSlot {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Contributed body takeovers, already sorted ascending by priority — so the
  // first route match is the highest-priority winner.
  const bodyContributions = useSlotContributions('sidebar.body');

  // A contributed body whose route predicate matches wins the sidebar. It drills
  // in from the right like the session level; backing out to the roster slides
  // the dashboard in from the left. The optional chaining hardens against a
  // contribution registered without `visibleWhen` (possible at runtime despite
  // the required type, e.g. via a generic registry write) — missing predicate =
  // never matches, so a malformed registration can't hijack every route.
  const takeover = bodyContributions.find((c) => c.visibleWhen?.({ pathname }));
  if (takeover) {
    const Body = takeover.component;
    return {
      key: `body:${takeover.id}`,
      // Boundary + Suspense live here at the SLOT seam so every current and
      // future sidebar.body consumer inherits them: contributed bodies are
      // lazy-loaded, and AppShell is the _shell route component — without the
      // boundary a chunk-load 404 (stale tab after a redeploy) or a render
      // throw would escape to the router's defaultErrorComponent and replace
      // the entire shell instead of just this panel.
      body: (
        <SidebarBodyErrorBoundary contributionId={takeover.id}>
          <Suspense fallback={null}>
            <Body />
          </Suspense>
        </SidebarBodyErrorBoundary>
      ),
      direction: 1,
    };
  }

  return { key: 'dashboard', body: <DashboardSidebar />, direction: -1 };
}

/**
 * Returns the header content component keyed to the current route.
 *
 * All routes use a page-specific header with consistent `PageHeader` layout.
 * The session route includes a breadcrumb with the agent name.
 */
function useHeaderSlot({
  agentName,
  origin,
  originLabel,
}: {
  agentName: string | undefined;
  origin: SessionOrigin | undefined;
  originLabel: string | undefined;
}): HeaderSlot {
  const { pathname, searchStr } = useRouterState({
    select: (s) => ({ pathname: s.location.pathname, searchStr: s.location.searchStr }),
  });
  switch (pathname) {
    case '/':
      return { key: 'dashboard', content: <DashboardHeader />, borderStyle: undefined };
    case '/agents': {
      const viewParam = new URLSearchParams(searchStr).get('view');
      const validViews = ['list', 'topology', 'denied', 'access'] as const;
      const viewMode = validViews.includes(viewParam as (typeof validViews)[number])
        ? (viewParam as (typeof validViews)[number])
        : 'list';
      return {
        key: 'agents',
        content: <AgentsHeader viewMode={viewMode} />,
        borderStyle: undefined,
      };
    }
    case '/tasks':
      return { key: 'tasks', content: <TasksHeader />, borderStyle: undefined };
    case '/activity':
      return { key: 'activity', content: <ActivityHeader />, borderStyle: undefined };
    case '/marketplace':
      return { key: 'marketplace', content: <MarketplaceHeader />, borderStyle: undefined };
    case '/marketplace/sources':
      return {
        key: 'marketplace-sources',
        content: <MarketplaceSourcesHeader />,
        borderStyle: undefined,
      };
    case '/session':
      return {
        key: 'session',
        content: <SessionHeader agentName={agentName} origin={origin} originLabel={originLabel} />,
        borderStyle: undefined,
      };
    default:
      return { key: 'dashboard', content: <DashboardHeader />, borderStyle: undefined };
  }
}

// ── AppShell component ────────────────────────────────────────

/**
 * Standalone app shell — shared layout for all routed views.
 * Renders sidebar, header, dialogs, and an Outlet for route content.
 *
 * This is the `component` for the pathless `_shell` layout route.
 * All route pages (DashboardPage, SessionPage) render inside the Outlet.
 *
 * The sidebar body directional-slides (200ms) and header content
 * cross-fades on route change via AnimatePresence, clipped inside the
 * sidebar. The sidebar footer and rail are static chrome — they never
 * animate.
 */
export function AppShell() {
  const { sidebarOpen, setSidebarOpen } = useAppStore();
  const [activeSessionId] = useSessionId();
  // Live route pathname threaded into the right panel so its tab `visibleWhen`
  // predicates re-evaluate on navigation. The container itself is router-free
  // (it takes pathname as a prop) so the same component mounts in the
  // router-less Obsidian embed, which passes a constant.
  const rightPanelPathname = useRouterState({ select: (s) => s.location.pathname });
  useDefaultCwd();

  const [selectedCwd] = useDirectoryState();
  const isStreaming = useAppStore((s) => s.isStreaming);
  const activeForm = useAppStore((s) => s.activeForm);
  const isWaitingForUser = useAppStore((s) => s.isWaitingForUser);
  const tasksBadgeCount = useAppStore((s) => s.tasksBadgeCount);
  const { data: currentAgent } = useCurrentAgent(selectedCwd);
  const agentVisual = useAgentVisual(currentAgent ?? null, selectedCwd ?? '');
  useFavicon({
    cwd: selectedCwd,
    isStreaming,
    color: currentAgent ? agentVisual.color : undefined,
  });
  useDocumentTitle({
    cwd: selectedCwd,
    activeForm,
    isStreaming,
    isWaitingForUser,
    agentName: currentAgent ? getAgentDisplayName(currentAgent) : undefined,
    agentEmoji: currentAgent ? agentVisual.emoji : undefined,
    tasksBadgeCount,
  });

  useShortcutsPanel();
  useRightPanelShortcut();
  useAgentProfileShortcut();
  useRightPanelPersistence();
  // Desktop shell → client navigation bridge (ADR 260709-210223). A no-op in
  // the browser and Obsidian, where `window.electronAPI` is absent.
  useElectronNavigate();
  // Bridge the global `/api/events` session-list stream into the shared
  // `['sessions', cwd]` query cache (sidebar/dashboard/loader go live; ADR-0265).
  useGlobalSessionStream();
  // Re-fetch the command registry when the server hot-reloads plugins after a
  // marketplace install/uninstall, so the command palette stays an honest
  // mirror of what the runtime recognizes (UX-12).
  useCommandsSync();
  // Keep channel state live across clients/tabs: invalidate bindings and adapter
  // status when the server signals a change, instead of relying on local
  // mutations and slow polling.
  useBindingsSync();
  useRelayAdaptersSync();
  // Make the Pulse Activity teaser live off `/api/events`: invalidate the
  // activity caches when an activity-generating broadcast (relay traffic/topology,
  // extension reloads) fires, coalescing bursts. Attention's live source
  // (sessions) already rides the list stream; its other sources have no server
  // event and stay poll-based — see the hook's doc for the honest topology.
  usePulseFreshness();

  const onboardingHiddenForSession = useAppStore((s) => s.onboardingHiddenForSession);
  const setOnboardingHiddenForSession = useAppStore((s) => s.setOnboardingHiddenForSession);

  // First-run onboarding — gate rendering until config is loaded to prevent
  // a flash of the chat UI before the onboarding screen appears.
  const {
    shouldShowOnboarding,
    shouldShowGettingStarted,
    isLoading: isOnboardingLoading,
    dismiss: dismissOnboarding,
  } = useOnboarding();

  // Timeout fallback: if config never loads (server unreachable, fetch hangs),
  // fall through to main app after 3 seconds — better than a blank screen forever.
  const [loadingTimedOut, setLoadingTimedOut] = useState(false);
  useEffect(() => {
    if (!isOnboardingLoading) return;
    const timer = setTimeout(() => setLoadingTimedOut(true), 3000);
    return () => clearTimeout(timer);
  }, [isOnboardingLoading]);
  // The session flag hides the overlay immediately on finish/skip, ahead of the
  // authoritative `completedAt`/`dismissedAt` config write catching up. The
  // latch keeps the overlay mounted once shown so the `completedAt` write (made
  // when the finish screen is reached) can't unmount it before the user clicks
  // the finish CTA — only the session flag closes it.
  const showOnboarding = useOnboardingOverlayVisible({
    shouldShowOnboarding,
    onboardingHiddenForSession,
  });
  const handleOnboardingComplete = useCallback(
    () => setOnboardingHiddenForSession(true),
    [setOnboardingHiddenForSession]
  );

  // Route-aware sidebar and header slots — cross-fade on route change
  const sidebarSlot = useSidebarSlot();
  const { origin: activeSessionOrigin, originLabel: activeSessionOriginLabel } =
    useSessionOrigin(activeSessionId);
  const headerSlot = useHeaderSlot({
    agentName: currentAgent ? getAgentDisplayName(currentAgent) : undefined,
    origin: activeSessionOrigin,
    originLabel: activeSessionOriginLabel,
  });

  // Eligible global banners, ranked and rendered one-at-a-time by AppBannerSlot
  // (below the header, inside the inset — so the sidebar never paints over them).
  const appBanners = useAppBanners(activeSessionId);

  // Gate rendering until config is loaded — prevents a flash of chat UI before
  // onboarding appears on first run.
  if (isOnboardingLoading && !loadingTimedOut) {
    return <div className="bg-background h-dvh" />;
  }

  return (
    <TooltipProvider>
      <MotionConfig reducedMotion="user">
        <AnimatePresence mode="wait">
          {showOnboarding ? (
            <motion.div
              key="onboarding"
              initial={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-50"
            >
              <OnboardingFlow
                onComplete={handleOnboardingComplete}
                renderRuntimeConnect={renderRuntimeConnect}
              />
            </motion.div>
          ) : (
            <motion.div
              key="main-app"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
              className="h-dvh"
            >
              <div
                data-testid="app-shell"
                className="bg-background text-foreground flex h-dvh flex-col"
              >
                <SidebarProvider
                  open={sidebarOpen}
                  onOpenChange={setSidebarOpen}
                  className="flex-1 overflow-hidden"
                  style={{ '--sidebar-width': '20rem' } as React.CSSProperties}
                >
                  <Sidebar variant="inset">
                    <TitlebarDragStrip />
                    {/* ── Dynamic sidebar body with directional slide ──
                          This wrapper is the clip boundary for the body swap. The
                          slide transform lives on the motion.div below, so the
                          motion.div's own `overflow-hidden` can only clip its
                          children — never its own translated box. The clip must
                          therefore sit on this ancestor: every body swap (dashboard,
                          session, and contributed takeovers, current and future)
                          slides within the sidebar shell seam, so mid-flight content
                          can't spill past the sidebar's edge. The footer and rail are
                          siblings of this wrapper, so they stay outside the clip. */}
                    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                      <AnimatePresence mode="wait" initial={false} custom={sidebarSlot.direction}>
                        <motion.div
                          key={sidebarSlot.key}
                          data-testid="sidebar-body-swap"
                          custom={sidebarSlot.direction}
                          initial="enter"
                          animate="center"
                          exit="exit"
                          variants={{
                            enter: (dir: number) => ({ x: `${dir * 100}%`, opacity: 0 }),
                            center: { x: 0, opacity: 1 },
                            exit: (dir: number) => ({ x: `${dir * -100}%`, opacity: 0 }),
                          }}
                          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                          className="flex min-h-0 flex-1 flex-col overflow-hidden"
                        >
                          {/* Contributed takeover bodies arrive pre-wrapped in
                                SidebarBodyErrorBoundary + Suspense at the slot
                                seam (useSidebarSlot); the built-in dashboard/
                                session bodies are eager and never suspend. */}
                          {sidebarSlot.body}
                        </motion.div>
                      </AnimatePresence>
                    </div>

                    {/* ── Static footer — never animates ── */}
                    <SidebarFooter className="border-t p-3">
                      {shouldShowGettingStarted && (
                        <div className="mb-2">
                          <ProgressCard onDismiss={dismissOnboarding} />
                        </div>
                      )}
                      <SidebarFooterBar />
                    </SidebarFooter>
                    <SidebarRail />
                  </Sidebar>
                  <SidebarInset className="overflow-hidden">
                    <header
                      className={cn(
                        'relative flex h-9 shrink-0 items-center gap-2 border-b px-2 transition-[border-color] duration-300',
                        // Literal class, not a `desktop-darwin:` variant utility — see
                        // the `.app-drag-region` comment in index.css. Inert without the
                        // `.desktop-darwin` ancestor class, so it's safe unconditionally.
                        'app-drag-region',
                        // When the sidebar is collapsed, TitlebarDragStrip's
                        // traffic-light clearance collapses with it — pad the
                        // header itself so its content doesn't sit under the
                        // native traffic lights (DOR-253).
                        !sidebarOpen && 'desktop-darwin:pl-20'
                      )}
                      style={headerSlot.borderStyle}
                    >
                      <SidebarTrigger className="-ml-0.5" />
                      <Separator orientation="vertical" className="mr-1 h-4" />
                      {/* ── Dynamic header content with cross-fade ── */}
                      <AnimatePresence mode="wait" initial={false}>
                        <motion.div
                          key={headerSlot.key}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.1 }}
                          className="flex min-w-0 flex-1 items-center gap-2"
                        >
                          {headerSlot.content}
                        </motion.div>
                      </AnimatePresence>
                      {/* ── Right panel toggle — far right, always present on every route ── */}
                      <RightPanelToggle />
                    </header>
                    {/* ── Global banner slot — one standing banner at a time, ranked
                          by priority. Sits below the header and inside the inset, so the
                          fixed sidebar can't paint over it and it never pushes the shell
                          header down. ── */}
                    <AppBannerSlot descriptors={appBanners} />
                    {/* --pip-dock (set by the mobile PIP mini-bar) lifts all
                          routed content above the 64px bar — nothing occluded. */}
                    <main className="flex-1 overflow-hidden pb-[var(--pip-dock,0px)]">
                      {/* The explicit id doubles as the DOM hook (data-panel-group-id)
                            that useRightPanelSizing measures for the pixel floor. */}
                      <PanelGroup
                        direction="horizontal"
                        id={RIGHT_PANEL_GROUP_ID}
                        autoSaveId={RIGHT_PANEL_GROUP_ID}
                      >
                        <Panel id="main-content" order={1} minSize={30} defaultSize={100}>
                          <Outlet />
                        </Panel>
                        <RightPanelContainer pathname={rightPanelPathname} />
                      </PanelGroup>
                    </main>
                  </SidebarInset>
                </SidebarProvider>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <DialogHost />
        <CommandPaletteDialog />
        <CreateAgentDialog />
        <ImportProjectsDialog />
        <ShortcutsPanel />
        <Toaster />
        <PipHost />
        <TourHost />
      </MotionConfig>
    </TooltipProvider>
  );
}
