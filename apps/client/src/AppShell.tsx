import { useEffect, useState, useCallback, Suspense } from 'react';
import { Outlet, useRouterState } from '@tanstack/react-router';
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
} from '@/layers/entities/session';
import { useCurrentAgent, useAgentVisual } from '@/layers/entities/agent';
import { useCommandsSync } from '@/layers/entities/command';
import { useBindingsSync } from '@/layers/entities/binding';
import { useRelayAdaptersSync } from '@/layers/entities/relay';
import { motion, AnimatePresence, LayoutGroup, MotionConfig } from 'motion/react';
import { PermissionBanner, DialogHost } from '@/layers/widgets/app-layout';
import { TelemetryConsentBanner } from '@/layers/features/telemetry-consent';
import { SessionSidebar, SidebarFooterBar } from '@/layers/features/session-list';
import { DashboardSidebar } from '@/layers/features/dashboard-sidebar';
import { useOnboarding, OnboardingFlow, ProgressCard } from '@/layers/features/onboarding';
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
import { PipHost } from '@/layers/features/pip-panel';
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
 * matches, the built-in behavior applies: the Dashboard sidebar is the default
 * and persists across all routes; users drill into the Session sidebar via the
 * active agent's "Sessions" action and return via the back button. Navigating
 * away from `/session` auto-resets to the dashboard level. The surrounding
 * chrome (trigger, footer, rail) never swaps — only this body does.
 */
function useSidebarSlot(): SidebarSlot {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const sidebarLevel = useAppStore((s) => s.sidebarLevel);
  const setSidebarLevel = useAppStore((s) => s.setSidebarLevel);
  // Contributed body takeovers, already sorted ascending by priority — so the
  // first route match is the highest-priority winner.
  const bodyContributions = useSlotContributions('sidebar.body');

  // Auto-reset to dashboard when leaving the session route
  useEffect(() => {
    if (pathname !== '/session' && sidebarLevel === 'session') {
      setSidebarLevel('dashboard');
    }
  }, [pathname, sidebarLevel, setSidebarLevel]);

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

  if (pathname === '/session' && sidebarLevel === 'session') {
    return { key: 'session', body: <SessionSidebar />, direction: 1 };
  }
  return { key: 'dashboard', body: <DashboardSidebar />, direction: -1 };
}

/**
 * Returns the header content component keyed to the current route.
 *
 * All routes use a page-specific header with consistent `PageHeader` layout.
 * The session route includes a breadcrumb with the agent name.
 */
function useHeaderSlot({ agentName }: { agentName: string | undefined }): HeaderSlot {
  const { pathname, searchStr } = useRouterState({
    select: (s) => ({ pathname: s.location.pathname, searchStr: s.location.searchStr }),
  });
  switch (pathname) {
    case '/':
      return { key: 'dashboard', content: <DashboardHeader />, borderStyle: undefined };
    case '/agents': {
      const viewParam = new URLSearchParams(searchStr).get('view');
      const validViews = ['list', 'topology', 'denied', 'access'] as const;
      const viewMode = validViews.includes(viewParam as any)
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
        content: <SessionHeader agentName={agentName} />,
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
 * Sidebar body and header content cross-fade (100ms) on route change via
 * AnimatePresence. The sidebar footer and rail are static chrome — they
 * never animate.
 */
export function AppShell() {
  const { sidebarOpen, setSidebarOpen } = useAppStore();
  const [activeSessionId] = useSessionId();
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

  const setOnboardingStep = useAppStore((s) => s.setOnboardingStep);

  // First-run onboarding — gate rendering until config is loaded to prevent
  // a flash of the chat UI before the onboarding screen appears.
  const {
    shouldShowOnboarding,
    isLoading: isOnboardingLoading,
    dismiss: dismissOnboarding,
  } = useOnboarding();
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);

  // Timeout fallback: if config never loads (server unreachable, fetch hangs),
  // fall through to main app after 3 seconds — better than a blank screen forever.
  const [loadingTimedOut, setLoadingTimedOut] = useState(false);
  useEffect(() => {
    if (!isOnboardingLoading) return;
    const timer = setTimeout(() => setLoadingTimedOut(true), 3000);
    return () => clearTimeout(timer);
  }, [isOnboardingLoading]);
  const showOnboarding = shouldShowOnboarding && !onboardingDismissed;
  const handleOnboardingComplete = useCallback(() => setOnboardingDismissed(true), []);

  // Route-aware sidebar and header slots — cross-fade on route change
  const sidebarSlot = useSidebarSlot();
  const headerSlot = useHeaderSlot({
    agentName: currentAgent ? getAgentDisplayName(currentAgent) : undefined,
  });

  // Gate rendering until config is loaded — prevents a flash of chat UI before
  // onboarding appears on first run.
  if (isOnboardingLoading && !loadingTimedOut) {
    return <div className="bg-background h-dvh" />;
  }

  return (
    <TooltipProvider>
      <MotionConfig reducedMotion="user">
        <LayoutGroup id="onboarding-to-chat">
          <AnimatePresence mode="wait">
            {showOnboarding ? (
              <motion.div
                key="onboarding"
                initial={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="fixed inset-0 z-50"
              >
                <OnboardingFlow onComplete={handleOnboardingComplete} />
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
                  <TelemetryConsentBanner />
                  <PermissionBanner sessionId={activeSessionId} />
                  <SidebarProvider
                    open={sidebarOpen}
                    onOpenChange={setSidebarOpen}
                    className="flex-1 overflow-hidden"
                    style={{ '--sidebar-width': '20rem' } as React.CSSProperties}
                  >
                    <Sidebar variant="inset">
                      <TitlebarDragStrip />
                      {/* ── Dynamic sidebar body with directional slide ── */}
                      <AnimatePresence mode="wait" initial={false} custom={sidebarSlot.direction}>
                        <motion.div
                          key={sidebarSlot.key}
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

                      {/* ── Static footer — never animates ── */}
                      <SidebarFooter className="border-t p-3">
                        {shouldShowOnboarding && (
                          <div className="mb-2">
                            <ProgressCard
                              onStepClick={(stepIndex) => setOnboardingStep(stepIndex)}
                              onDismiss={dismissOnboarding}
                            />
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
                        {/* ── Right panel toggle — far right, hides when no contributions ── */}
                        <RightPanelToggle />
                      </header>
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
                          <RightPanelContainer />
                        </PanelGroup>
                      </main>
                    </SidebarInset>
                  </SidebarProvider>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </LayoutGroup>
        <DialogHost />
        <CommandPaletteDialog />
        <CreateAgentDialog />
        <ShortcutsPanel />
        <Toaster />
        <PipHost />
      </MotionConfig>
    </TooltipProvider>
  );
}
