import { useEffect, useState, useCallback, useMemo, Suspense } from 'react';
import { Outlet, useRouterState } from '@tanstack/react-router';
import {
  useAppStore,
  useFavicon,
  useDocumentTitle,
  useIsMobile,
  useSlotContributions,
} from '@/layers/shared/model';
import { useElectronNavigate } from './app/use-electron-navigate';
import { useElectronCloseTab } from './app/use-electron-close-tab';
import { useElectronFullscreen } from './app/use-electron-fullscreen';
import { useWindowFocusDimming } from './app/use-window-focus-dimming';
import { useRoomDocumentTitle } from './app/use-room-document-title';
import { TitlebarDragStrip } from './app/TitlebarDragStrip';
import { SidebarBodyErrorBoundary } from './app/SidebarBodyErrorBoundary';
import { ServerUnreachableScreen } from './app/ServerUnreachableScreen';
import {
  getAgentDisplayName,
  cn,
  isDesktopShell,
  normalizeTeamView,
  LAUNCH_STARTED_AT,
} from '@/layers/shared/lib';
// Off the barrel by construction — see the module's own note.
import { basename } from '@/layers/shared/lib/basename';
import {
  useSessionId,
  useDefaultCwd,
  useDirectoryState,
  useGlobalSessionStream,
  useSessionOrigin,
  useSessionDetail,
} from '@/layers/entities/session';
import { useCurrentAgent, useAgentVisual } from '@/layers/entities/agent';
import { useConfig } from '@/layers/entities/config';
import { useCommandsSync } from '@/layers/entities/command';
import { useBindingsSync } from '@/layers/entities/binding';
import { useRelayAdaptersSync } from '@/layers/entities/relay';
import { useUnattendedAutonomySync } from '@/layers/entities/unattended-autonomy';
import { useTasksSync } from '@/layers/entities/tasks';
import { useTunnelSync, useRemoteAccessAnnouncer } from '@/layers/entities/tunnel';
import { motion, AnimatePresence, MotionConfig, useReducedMotion } from 'motion/react';
import { shouldFadeRoute } from './app/route-fade';
import { DialogHost, FeedbackDialogHost } from '@/layers/widgets/app-layout';
import { AppBannerSlot, useAppBanners } from '@/layers/widgets/app-banner';
import { MomentHost } from '@/layers/widgets/moments';
import { usePulseFreshness } from '@/layers/widgets/pulse';
import {
  DashboardSidebar,
  SidebarFooterStrip,
  SidebarHeaderBlock,
} from '@/layers/features/dashboard-sidebar';
import {
  useOnboarding,
  useOnboardingOverlayVisible,
  useClearOnboardingStageWhenDone,
  OnboardingFlow,
} from '@/layers/features/onboarding';
import { renderRuntimeConnect } from '@/layers/features/runtime-connect';
import {
  BarFixedCluster,
  OneBarProvider,
  resolveRouteHeader,
  type OneBarRouteState,
} from '@/layers/widgets/one-bar';
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
import { MobileTabsLayout, useMobilePanelStore } from '@/layers/widgets/mobile-tabs';
import { ControlCenter, useControlCenterShortcut } from '@/layers/widgets/control-center';
import { RemoteAccessBeacon } from '@/layers/widgets/remote-access';
import {
  AppTabBar,
  APP_TAB_PANEL_ID,
  useAppTabsSync,
  useAppTabShortcuts,
} from '@/layers/features/app-tabs';
import { CommandPaletteDialog, MessageSearchDialog } from '@/layers/features/command-palette';
import { CreateAgentDialog } from '@/layers/features/agent-creation';
import { ImportProjectsDialog } from '@/layers/features/mesh';
import { PipHost } from '@/layers/features/pip-panel';
import { TourHost } from '@/layers/features/tours';
import { NotificationCenter } from '@/layers/features/notifications';
import { ShortcutsPanel, useShortcutsPanel } from '@/layers/features/shortcuts';
import { PanelGroup, Panel } from 'react-resizable-panels';
import {
  RightPanelContainer,
  useRightPanelPersistence,
  useRightPanelShortcut,
  RIGHT_PANEL_GROUP_ID,
} from '@/layers/features/right-panel';
import {
  useLegacyProfileLinkRedirect,
  useProfileDockDeepLink,
  useProfileShortcut,
} from '@/layers/features/profile';

/**
 * How long a config read may hang before the shell calls the server unreachable.
 *
 * **Not the 3s escape hatch below, and the gap is the point.** A rejection is
 * proof; a request that has not come back is only a wait, and the inline boot
 * sentinel's own deadlines are set the same way — long enough that a machine
 * which was merely busy is never accused. Fifteen seconds is past every healthy
 * boot measured on this app, including a cold desktop start where the server is
 * still coming up, and it is the point at which "still starting" and "wedged"
 * stop being worth telling apart: the screen says the same honest thing about
 * both, and clears itself the moment either resolves.
 */
const SERVER_HANG_DEADLINE_MS = 15_000;

// ── Private slot types ────────────────────────────────────────

interface SidebarSlot {
  /** Stable key for AnimatePresence — triggers transition on change */
  key: string;
  /** The sidebar body component to render */
  body: React.ReactNode;
  /** Slide direction: 1 = slide in from right (drilling in), -1 = slide in from left (backing out) */
  direction: 1 | -1;
  /**
   * Whether {@link SidebarSlot.body} is a contributed `sidebar.body` takeover
   * rather than the built-in roster.
   *
   * The two widths spend a takeover differently: on desktop it replaces the
   * whole body, and on a phone it replaces the Library tab and leaves Home
   * standing (P4). So the shell has to say which kind of body this is, rather
   * than the mobile layout guessing from a key string.
   */
  isTakeover: boolean;
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
      isTakeover: true,
    };
  }

  return { key: 'dashboard', body: <DashboardSidebar />, direction: -1, isTakeover: false };
}

/**
 * The bar for the route that is showing, and the key its cross-fade animates on.
 *
 * This used to be a `pathname` switch here in the shell, which meant a new route
 * silently inherited the `default` branch's header — the defect that had every
 * channel and every DM reading "Dashboard" (DOR-587) and then had Workspaces,
 * Connections and Product feedback do the same thing (DOR-919). Routes declare
 * their own bar in `router.tsx` now, as required `staticData.header`, so a route
 * with no bar does not compile.
 */
function useRouteHeader() {
  const matches = useRouterState({ select: (s) => s.matches });
  return resolveRouteHeader(matches);
}

// ── AppShell component ────────────────────────────────────────

/**
 * Standalone app shell — shared layout for all routed views.
 * Renders sidebar, header, dialogs, and an Outlet for route content.
 *
 * This is the `component` for the pathless `_shell` layout route.
 * All route pages (HomeRoomPage, SessionPage) render inside the Outlet.
 *
 * The sidebar body directional-slides (200ms) and header content
 * cross-fades on route change via AnimatePresence, clipped inside the
 * sidebar. The routed page cross-fades with them (120ms, opacity only).
 * The sidebar footer and rail are static chrome — they never animate.
 */
export function AppShell() {
  const { sidebarOpen, setSidebarOpen } = useAppStore();
  // **The one call site that decides which cockpit this is** (spec §9, P4).
  // Below 768px the sidebar is not a narrower sidebar — it is four destinations
  // along the bottom of the screen and no drawer at all. Reverting this one
  // choice restores the off-canvas sheet, which stays in `shared/ui/sidebar.tsx`
  // as the shared primitive it always was (the Dev Playground and the component
  // tests mount it). It is NOT kept there for the Obsidian embed, whatever the
  // comment here used to say: the embed renders `EmbedSidebar`, which never
  // touches `<Sidebar>`.
  const isMobile = useIsMobile();
  // Whether a phone's tab panel is covering the routed page. The panels are an
  // opaque layer, so the page underneath has to be unreachable while they are
  // up — not merely invisible. Only this component can mark that page `inert`,
  // and only the layout knows, so the bit travels through the widget's store.
  const mobilePanelUp = useMobilePanelStore((s) => s.panelUp);
  const [activeSessionId] = useSessionId();
  // Live route pathname threaded into the right panel so its tab `visibleWhen`
  // predicates re-evaluate on navigation. The container itself is router-free
  // (it takes pathname as a prop) so the same component mounts in the
  // router-less Obsidian embed, which passes a constant.
  const rightPanelPathname = useRouterState({ select: (s) => s.location.pathname });
  // See `route-fade.ts`: an inline opacity tween is invisible to both the
  // global reduced-motion CSS reset and `MotionConfig reducedMotion="user"`,
  // so the fade below needs its own gate.
  const fadesRoute = shouldFadeRoute(useReducedMotion() ?? false);
  useDefaultCwd();

  const [selectedCwd] = useDirectoryState();
  const isStreaming = useAppStore((s) => s.isStreaming);
  const activeForm = useAppStore((s) => s.activeForm);
  const isWaitingForUser = useAppStore((s) => s.isWaitingForUser);
  const tasksBadgeCount = useAppStore((s) => s.tasksBadgeCount);
  const { data: currentAgent } = useCurrentAgent(selectedCwd);
  const agentVisual = useAgentVisual(currentAgent ?? null, selectedCwd ?? '');
  // The tab names the room you are reading when there is one, and counts the
  // rooms waiting on you whichever route you are on (spec `rooms` §13.1/§13.3).
  const { room: openRoom, roomTitle, unreadRoomCount } = useRoomDocumentTitle();
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
    roomTitle,
    unreadRoomCount,
  });

  useShortcutsPanel();
  useRightPanelShortcut();
  useProfileShortcut();
  useControlCenterShortcut();
  // Mounted at the shell, not inside the panel: a link that opens the profile
  // has to work when the profile is not already what you are looking at.
  useLegacyProfileLinkRedirect();
  useProfileDockDeepLink();
  useRightPanelPersistence();
  // In-window tabs (DOR-540). The sync hook is the single reconciliation point
  // between the router's location and the tab set — every navigation, whatever
  // started it, lands here. Both no-op outside the desktop shell, where the
  // strip does not exist (DOR-568).
  useAppTabsSync();
  useAppTabShortcuts();
  // Desktop shell → client navigation bridge (ADR 260709-210223). A no-op in
  // the browser and Obsidian, where `window.electronAPI` is absent.
  useElectronNavigate();
  // Desktop Cmd+W → close a tab, not the window. No-op without the bridge, and
  // deliberately silent on the last tab so the window still closes.
  useElectronCloseTab();
  // Whether the desktop window is fullscreen (DOR-563) — macOS retracts the
  // traffic lights into the auto-hiding menu bar there, so the tab strip's
  // clearance for them (below) is dropped for as long as this holds. Always
  // `false` without the bridge.
  const isFullscreen = useElectronFullscreen();
  // Dim the chrome when the window loses focus (DOR-254) — a no-op outside
  // the macOS desktop shell.
  useWindowFocusDimming();
  // Bridge the global `/api/events` session-list stream into the shared
  // session-list query cache (sidebar/dashboard/loader go live; ADR-0265).
  useGlobalSessionStream();
  // Re-fetch the command registry when the server hot-reloads plugins after a
  // marketplace install/uninstall, so the command palette stays an honest
  // mirror of what the runtime recognizes (UX-12).
  useCommandsSync();
  // Keep integration state live across clients/tabs: invalidate bindings and adapter
  // status when the server signals a change, instead of relying on local
  // mutations and slow polling.
  useBindingsSync();
  useRelayAdaptersSync();
  // Keep the standing unattended-autonomy banner honest the moment a binding or
  // a task changes: dialling one up to Full autonomy has to raise the banner as
  // the form closes, not on the next reload.
  useUnattendedAutonomySync();
  // Live task list (DOR-1380): a schedule an agent proposes via MCP parks at
  // pending_approval and otherwise sits invisible until the next reload.
  useTasksSync();
  // Remote access, live and audible — the two halves that must happen exactly
  // once for the whole app (DOR-1743). `useTunnelSync` refreshes the config
  // read from other tabs and from the server's `tunnel_status` stream, which
  // nothing had been listening to since the sidebar footer's globe went;
  // `useRemoteAccessAnnouncer` says something when a tunnel drops or comes back
  // without you. Both were previously reachable only through the Remote Access
  // dialog's own hook, which is a dialog and not a place for app-wide plumbing.
  useTunnelSync();
  useRemoteAccessAnnouncer();
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
  // `shouldShowGettingStarted` and `dismiss` were read here for the
  // `ProgressCard` this footer used to stack; the bottom slot owns that card and
  // its dismissal now (spec `sidebar-simplification` D4).
  const {
    shouldShowOnboarding,
    isLoading: isOnboardingLoading,
    isOnboardingComplete,
    isOnboardingDismissed,
  } = useOnboarding();

  // The session flag hides the overlay immediately on finish/skip, ahead of the
  // authoritative `completedAt`/`dismissedAt` config write catching up. The
  // latch keeps the overlay mounted once shown so the `completedAt` write (made
  // mid-conversation, when the handoff beat is reached) can't unmount it before
  // the user's first message dissolves it — only the session flag closes it.
  const showOnboarding = useOnboardingOverlayVisible({
    shouldShowOnboarding,
    onboardingHiddenForSession,
  });

  // Keep the `?onboarding=` stage param honest: once onboarding is finished or
  // dismissed AND the overlay has actually closed, strip a lingering stage param
  // (left by finishing, or deep-linked by a returning user) so the URL stays
  // clean. The overlay gate matters because the conversation writes `completedAt`
  // mid-flow — stripping while it is still latched open would rewind the derived
  // stage to `welcome` and destroy the in-progress conversation.
  useClearOnboardingStageWhenDone({
    done: isOnboardingComplete || isOnboardingDismissed,
    overlayVisible: showOnboarding,
  });

  // **A failed config read is not a slow one, and the gate below cannot tell.**
  // `isLoading` is `isPending && isFetching`, so the moment the read ERRORS it
  // reads false with nothing in hand: the shell fell through to a first-run
  // overlay that could not save a single answer it collected, and before that
  // to `<div class="bg-background h-dvh" />` — a black rectangle
  // indistinguishable from the v0.63.0 crash (DOR-1475).
  //
  // Same cache entry as the onboarding gate's read (one key, one request), so
  // this observes that failure rather than causing a second one.
  //
  // **"Has data" is the wrong question, because the boot cache always has
  // data.** `query-persister.ts` restores `configKeys.current()` out of
  // `localStorage`, up to 24 hours old, so every returning user starts with a
  // config in hand. Gated on `data === undefined`, this screen was unreachable
  // for exactly the people most likely to hit it: the shell painted the whole
  // cockpit — sidebar, rooms, agents, all from last night's copy — over a
  // server that answered nothing, and every action inside it failed. So the
  // test is whether the server has answered THIS launch
  // (`dataUpdatedAt > LAUNCH_STARTED_AT`, the distinction the moments rail
  // already draws), not whether the browser remembers something.
  //
  // **`errorUpdateCount`, not `isError`, and the difference is a hot loop.**
  // TanStack resets a query with NO data back to `status: 'pending'` and clears
  // its error the instant a retry STARTS (`fetchState` in query-core), so
  // `isError` reads false for the whole of every retry — including the one the
  // failure screen's own mount kicks off. Gated on `isError`, the screen
  // mounted, triggered a refetch, saw pending, unmounted, saw the rejection,
  // and mounted again: measured at ~3000 requests in 500ms, at a server that is
  // already down. `errorUpdateCount` only counts failures and never rewinds, so
  // "we asked, it failed, and we still have nothing fresh" survives the retry
  // that the answer itself sets off.
  const { dataUpdatedAt: configAnsweredAt, errorUpdateCount: configFailures } = useConfig();
  const answeredThisLaunch = configAnsweredAt > LAUNCH_STARTED_AT;

  // **The wedged server never errors, so failures alone cannot see it.** A
  // server that accepts the connection and then says nothing leaves the read
  // pending forever: no rejection, no `errorUpdateCount`, and the 3s escape
  // below hands the window to a shell whose every query is hanging too. A
  // deadline is the only evidence available for that one — and it is
  // deliberately far longer than the 3s escape, because the cost of being wrong
  // here is the boot sentinel's lesson: accusing a machine that was merely
  // slow. Fifteen seconds with nothing fresh in hand is no longer slow.
  const [hangDeadlinePassed, setHangDeadlinePassed] = useState(false);
  useEffect(() => {
    if (answeredThisLaunch) return;
    const timer = setTimeout(() => setHangDeadlinePassed(true), SERVER_HANG_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [answeredThisLaunch]);

  // Either kind of evidence, and in both cases only while nothing fresh has
  // arrived — so a cockpit that IS talking to its server never sees this, and
  // one whose server comes back mid-screen loses it on the next answer.
  const isServerUnreachable = !answeredThisLaunch && (configFailures > 0 || hangDeadlinePassed);

  // Timeout fallback: if config never loads (server unreachable, fetch hangs),
  // fall through to main app after 3 seconds — better than a blank screen forever.
  const [loadingTimedOut, setLoadingTimedOut] = useState(false);
  useEffect(() => {
    if (!isOnboardingLoading) return;
    const timer = setTimeout(() => setLoadingTimedOut(true), 3000);
    return () => clearTimeout(timer);
  }, [isOnboardingLoading]);
  const handleOnboardingComplete = useCallback(
    () => setOnboardingHiddenForSession(true),
    [setOnboardingHiddenForSession]
  );

  // Route-aware sidebar and header slots — cross-fade on route change
  const sidebarSlot = useSidebarSlot();
  const { origin: activeSessionOrigin, originLabel: activeSessionOriginLabel } =
    useSessionOrigin(activeSessionId);
  // The session's own name, out of the one session cache the sidebar list, the
  // recents and every other reader share — so the bar cannot call a session
  // something the list you picked it from doesn't. `select` narrows the
  // subscription to the title, so an unrelated settings write to the same row
  // doesn't re-render the shell.
  //
  // `enabled: false` is deliberate and load-bearing. The bar REPORTS a session's
  // name; it does not own the session. Every route that needs the row already
  // fetches it, and the global session stream patches this cache directly
  // (`syncSessionDetailCache`), so the title still arrives and still updates
  // live. What this rules out is the shell adding a fetch of its own to a key
  // other surfaces read — the permission control resolves the session's runtime
  // from this same row, and a shell-initiated request racing session creation
  // would put a row they then read into the cache. The hook documents exactly
  // this case: a caller that only reports on a session someone else owns.
  const { data: activeSessionTitle } = useSessionDetail(activeSessionId, {
    enabled: false,
    select: (session) => session.title,
  });
  const routeHeader = useRouteHeader();
  const searchStr = useRouterState({ select: (st) => st.location.searchStr });
  // What every route bar reads but no route resolves for itself — the shell has
  // these already, and resolving them twice is how two places end up disagreeing
  // about which room is open.
  const oneBarState = useMemo<OneBarRouteState>(
    () => ({
      sessionId: activeSessionId ?? undefined,
      agentName: currentAgent ? getAgentDisplayName(currentAgent) : undefined,
      // Only when there IS an agent. `useAgentVisual` hashes a face out of the
      // cwd otherwise, which is right for a favicon and wrong for the bar: a
      // face there says "this is an agent", and a bare directory is not one.
      agentVisual: currentAgent ? agentVisual : undefined,
      origin: activeSessionOrigin,
      originLabel: activeSessionOriginLabel,
      sessionTitle: activeSessionTitle,
      sessionDirectoryName: selectedCwd ? basename(selectedCwd) : undefined,
      room: openRoom,
      // Read straight off the URL rather than through `useSearch`, so the bar
      // keeps rendering during a route exit animation — and normalized through
      // the same function the route validates with, so the bar and the page can
      // never disagree about which view is showing.
      teamViewMode: normalizeTeamView(new URLSearchParams(searchStr).get('view') ?? undefined),
    }),
    [
      activeSessionId,
      currentAgent,
      agentVisual,
      activeSessionOrigin,
      activeSessionOriginLabel,
      activeSessionTitle,
      selectedCwd,
      openRoom,
      searchStr,
    ]
  );

  // Eligible global banners, ranked and rendered one-at-a-time by AppBannerSlot
  // (below the header, inside the inset — so the sidebar never paints over them).
  const appBanners = useAppBanners(activeSessionId);

  // Say so — ahead of the quiet gate below, which passes for a black window,
  // and ahead of the whole cockpit, which a restored cache would otherwise
  // paint over a server that is not there.
  //
  // Deliberately NOT behind the 3s escape: that timer only runs while
  // `isOnboardingLoading` is true, and a refused connection ends that within a
  // retry — gating on it would mean the commonest dead-server case never
  // reached this screen at all. The hang has its own, much longer deadline
  // instead.
  if (isServerUnreachable) {
    return <ServerUnreachableScreen />;
  }

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
                  // `min-h-0` on a phone, and it is load-bearing. The provider's
                  // own wrapper carries `min-h-svh`, which was free while it was
                  // the only child of this `h-dvh` column. The bottom bar is a
                  // second child, so the two together demand 56px more than the
                  // screen has and the flex column resolves that by pushing its
                  // first child UP — measured at 390×844, the inset started at
                  // -56 and the route's own header (the room name) sat off the
                  // top of the screen. `min-h-0` lets `flex-1` shrink instead.
                  className={cn('flex-1 overflow-hidden', isMobile && 'min-h-0')}
                  // **The visible panel is 272px** (design-decisions §11;
                  // 20rem was 320, which the design-system guide's own
                  // "240–280px" line had already contradicted).
                  //
                  // Written as the sum rather than as a round number because
                  // this variable sizes the SLOT, and the `inset` variant spends
                  // 8px of it as padding on each side before the tinted surface
                  // starts. 272 is the number the design states and the number a
                  // browser test measures on `sidebar-inner`; the `+ 1rem` is
                  // the gutter it floats in.
                  style={{ '--sidebar-width': 'calc(272px + 1rem)' } as React.CSSProperties}
                >
                  {/* ── The panel, on anything wider than a phone ──
                        Not rendered at all below 768px, which is what makes
                        "no drawer, no sheet" structural rather than styled:
                        the Radix Sheet lives INSIDE `<Sidebar>`, so a phone
                        has no sheet to open and nothing to dismiss. The router
                        subscription that used to close it after every
                        navigation (`SidebarMobileNavigationClose`) retired with
                        it — with four destinations along the bottom there is
                        nothing to put away (P4). */}
                  {!isMobile && (
                    <Sidebar variant="inset">
                      <TitlebarDragStrip isFullscreen={isFullscreen} />
                      {/* ── The header block: persistent chrome ──
                          The mount point for the workspace switcher, the New
                          button and the ⌘K pill (spec BC-43→46, task P2.4). It
                          belongs OUTSIDE the body-swap wrapper below, so a
                          contributed `sidebar.body` takeover replaces the body
                          and leaves the panel's identity standing (spec
                          `sidebar-now-today-library` R2, P2 AC-8) — which is the
                          same arrangement the footer strip has and always had.
                          The four destinations that used to sit here are in the
                          footer strip now, so this panel has exactly one nav
                          implementation and this block is only what it says it
                          is: whose cockpit this is, one New button, one ⌘K
                          pill (BC-43 → BC-46). */}
                      <SidebarHeaderBlock />
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
                      {/* No hairline above the footer either — the footer is one
                        slim tinted strip, and the scroll-edge shadow on the body
                        above is what says content continues under it (spec R1). */}
                      {/* The getting-started card, the profile prompt and the
                          update pill were all here, stacked. They are candidates
                          in the sidebar's bottom slot now — one card at a time,
                          pinned just above this footer — so the footer is only
                          the thing it is named for (spec D4). */}
                      <SidebarFooter className="px-2 py-3">
                        <SidebarFooterStrip />
                      </SidebarFooter>
                      <SidebarRail />
                    </Sidebar>
                  )}
                  <SidebarInset
                    className="overflow-hidden"
                    // **The covered page is unreachable, not merely hidden.**
                    // A phone's tab panel is an opaque layer over this inset,
                    // and an opaque layer that leaves 23 focusable elements
                    // behind it is a keyboard trap in reverse: Tab walks into
                    // a page nobody can see (review B2). The Radix Sheet got
                    // this for free from its own modality; the tabs have to
                    // ask for it. `inert` takes the subtree out of the tab
                    // order AND out of the accessibility tree, which is both
                    // halves of what the sheet was doing.
                    inert={isMobile && mobilePanelUp}
                  >
                    {/* ── Window tabs — the inset's top band, above the page
                          header (DOR-540). Desktop app only (DOR-568): a browser
                          already has tabs, and a second strip under the real one
                          would be the worse of the two. On macOS this is the
                          strip that sits level with the traffic lights, so it
                          carries the drag region and, when the sidebar is
                          collapsed, the clearance the header used to need. The
                          header below keeps its own drag region, so the browser
                          layout simply starts one band higher. ── */}
                    {isDesktopShell() && (
                      <AppTabBar
                        className={cn(
                          // Literal class, not a `desktop-darwin:` variant utility — see
                          // the `.app-drag-region` comment in index.css. Inert without the
                          // `.desktop-darwin` ancestor class, so it's safe unconditionally.
                          'app-drag-region',
                          // When the sidebar is collapsed, TitlebarDragStrip's
                          // traffic-light clearance collapses with it — pad this
                          // strip so the first tab doesn't sit under the native
                          // traffic lights (DOR-253). Dropped in fullscreen
                          // (DOR-563): the traffic lights retract into the
                          // auto-hiding menu bar there, so there is nothing
                          // left to clear.
                          !sidebarOpen && !isFullscreen && 'desktop-darwin:pl-20'
                        )}
                      />
                    )}
                    <header
                      // `app-drag-region` is a literal class, not a
                      // `desktop-darwin:` variant utility — see the
                      // `.app-drag-region` comment in index.css. Inert without
                      // the `.desktop-darwin` ancestor, so it is unconditional.
                      // `@container/bar` makes the row itself the thing bars
                      // measure against. A bar's crowding is a fact about the
                      // width it HAS, and that is not the window's: collapsing
                      // the sidebar takes this row from 524px to 804px at a
                      // fixed window size (measured). A `sm:` breakpoint keyed
                      // to the viewport would answer the wrong question — and
                      // answer it wrongly in the playground too, where a 390px
                      // bar sits inside a 1440px page.
                      className="app-drag-region @container/bar relative flex h-9 shrink-0 items-center gap-2 border-b px-2 transition-[border-color] duration-300"
                    >
                      {/* A phone has no panel to toggle, so it gets no toggle.
                          A hamburger that opens nothing is worse than no
                          hamburger — and the four destinations it used to reach
                          are along the bottom of the screen now (P4). */}
                      {!isMobile && (
                        <>
                          <SidebarTrigger className="-ml-0.5" />
                          <Separator orientation="vertical" className="mr-1 h-4" />
                        </>
                      )}
                      {/* ── The route's bar, cross-faded on route change.
                            ONLY the route's own half fades: identity, chips and
                            page actions are what differ between routes, so they
                            are what animates. ── */}
                      <AnimatePresence mode="wait" initial={false}>
                        {routeHeader && (
                          <motion.div
                            key={routeHeader.key}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.1 }}
                            // `self-stretch` so the row's full height is available
                            // to a bar that wants it. The header centres its
                            // children, which left this wrapper only as tall as
                            // its text — and a tab strip asking for `h-full`
                            // inside it got 24px, so every home tab was a 24px
                            // target in a 36px row (DOR-1401). Stretched, the
                            // tabs measure 35px: the header's 36 less the 1px
                            // that is its bottom hairline. Children still centre
                            // themselves (`items-center`); only the box they
                            // measure against changed.
                            className="flex min-w-0 flex-1 items-center gap-2 self-stretch"
                          >
                            <OneBarProvider value={oneBarState}>
                              <routeHeader.Header />
                            </OneBarProvider>
                          </motion.div>
                        )}
                      </AnimatePresence>
                      {/* The Control Center glyph, in the persistent cluster so
                            it is present on every route and on both desktop and
                            mobile — the honest "always visible" anchor (spec
                            D7). Outside the cross-fade like the cluster, so it
                            never blinks on navigation. */}
                      <ControlCenter />
                      {/* The remote-access beacon, beside it and on the same
                            terms — present on every route, outside the
                            cross-fade — but only while a tunnel is actually
                            starting, up, or re-establishing itself. With remote
                            access off it draws nothing at all (DOR-1743). */}
                      <RemoteAccessBeacon />
                      {/* ── Search · inbox · right-panel toggle. Outside the
                            cross-fade and after it, which is both halves of
                            I1: they stay mounted so the corner never blinks on
                            navigation, and the route's bar — confined to the
                            sibling above — cannot render anything past them. ── */}
                      <BarFixedCluster />
                    </header>
                    {/* ── Global banner slot — one standing banner at a time, ranked
                          by priority. Sits below the header and inside the inset, so the
                          fixed sidebar can't paint over it and it never pushes the shell
                          header down. ── */}
                    <AppBannerSlot descriptors={appBanners} />
                    {/* --pip-dock (set by the mobile PIP mini-bar) lifts all
                          routed content above the 64px bar.

                          **This padding was never the whole of "nothing
                          occluded", and the comment here used to claim it
                          was.** It covers the routed page and nothing else: the
                          phone's tab bar is a sibling of this provider and the
                          tab panels are a `fixed` layer, so neither of them
                          reads this variable and a docked PIP painted straight
                          over both (DOR-1177). Those two are handled where they
                          live — the bar keeps the bottom edge and the mini-bar
                          docks above it (`--mobile-tab-dock`), and the panels
                          add `--pip-dock` to the height they stop at. What is
                          true here is the narrow thing: the routed page clears
                          the bar. */}
                    <main
                      // The region the active tab controls (`aria-controls`).
                      id={APP_TAB_PANEL_ID}
                      className="flex-1 overflow-hidden pb-[var(--pip-dock,0px)]"
                    >
                      {/* The explicit id doubles as the DOM hook (data-panel-group-id)
                            that useRightPanelSizing measures for the pixel floor. */}
                      <PanelGroup
                        direction="horizontal"
                        id={RIGHT_PANEL_GROUP_ID}
                        autoSaveId={RIGHT_PANEL_GROUP_ID}
                      >
                        <Panel id="main-content" order={1} minSize={30} defaultSize={100}>
                          {/* ── The page itself, faded in on route change ──
                              The sidebar body slides and the header cross-fades
                              already; the body they describe used to swap in a
                              single frame, so the chrome moved and the content
                              did not.

                              **Enter only, no exit, and no `AnimatePresence`.**
                              `<Outlet />` is not a snapshot — it reads live
                              router state — so an exiting keyed wrapper here
                              would re-render as the NEW route's content and
                              animate it out, then `mode="wait"` would mount an
                              identical tree back in: the page would paint,
                              blank, and repaint on every navigation. Dropping
                              the exit removes the coordination problem instead
                              of solving it, the same call `TabsContent` makes.

                              **Opacity only, and that is the safe form.** A
                              transform on this wrapper would make it a
                              containing block for the `fixed` PIP layer inside
                              it and would change what the panel group measures.
                              The key is the pathname, not the full location, so
                              switching sessions on `/session` keeps its own
                              150ms crossfade instead of taking two.

                              **Gated by `fadesRoute`** (see `route-fade.ts`):
                              an inline opacity tween is invisible to the global
                              reduced-motion CSS reset and to `MotionConfig`
                              alike, so a reader who asked for less motion gets
                              `initial={false}` — the page just appears. ── */}
                          <motion.div
                            key={rightPanelPathname}
                            initial={fadesRoute ? { opacity: 0 } : false}
                            animate={{ opacity: 1 }}
                            transition={
                              fadesRoute ? { duration: 0.12, ease: 'easeOut' } : { duration: 0 }
                            }
                            data-route-fade={fadesRoute}
                            className="h-full"
                          >
                            <Outlet />
                          </motion.div>
                        </Panel>
                        <RightPanelContainer pathname={rightPanelPathname} />
                      </PanelGroup>
                    </main>
                  </SidebarInset>
                </SidebarProvider>
                {/* ── The phone cockpit: four destinations, no drawer ──
                      A sibling of the provider rather than a child of it, so
                      the bar reserves its own room at the bottom of the shell
                      and no routed page has to know it exists to avoid being
                      covered by it. Its panels are what Now, Today and Library
                      look like when they get the whole screen. */}
                {isMobile && (
                  <MobileTabsLayout takeover={sidebarSlot.isTakeover ? sidebarSlot.body : null} />
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <DialogHost />
        {/* The moments rail — one-time modals, at most one per app launch. It
            is told whether the onboarding overlay is up rather than working it
            out, because the shell owns that overlay and its latch. */}
        <MomentHost onboardingOverlayVisible={showOnboarding} />
        <FeedbackDialogHost />
        <CommandPaletteDialog />
        <MessageSearchDialog />
        <CreateAgentDialog />
        <ImportProjectsDialog />
        <ShortcutsPanel />
        <Toaster />
        <PipHost />
        <TourHost />
        {/* Draws nothing. Knocks when something starts waiting on you, and
            raises a browser notification if this tab is hidden while it does.
            Mounted here because both are about arrivals and have to outlive
            every route. */}
        <NotificationCenter />
      </MotionConfig>
    </TooltipProvider>
  );
}
