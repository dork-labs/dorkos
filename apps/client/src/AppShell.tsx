import { useEffect, useState, useCallback } from 'react';
import { Outlet } from '@tanstack/react-router';
import { useAppStore, useFavicon, useDocumentTitle } from '@/layers/shared/model';
import { useSessionId, useDefaultCwd, useDirectoryState } from '@/layers/entities/session';
import { useCurrentAgent, useAgentVisual } from '@/layers/entities/agent';
import { motion, AnimatePresence, MotionConfig } from 'motion/react';
import { PermissionBanner, DialogHost } from '@/layers/widgets/app-layout';
import { AgentSidebar } from '@/layers/features/session-list';
import { useOnboarding, OnboardingFlow } from '@/layers/features/onboarding';
import { AgentIdentityChip, CommandPaletteTrigger } from '@/layers/features/top-nav';
import {
  Toaster,
  TooltipProvider,
  Separator,
  Sidebar,
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from '@/layers/shared/ui';
import { CommandPaletteDialog } from '@/layers/features/command-palette';
import { ShortcutsPanel, useShortcutsPanel } from '@/layers/features/shortcuts';

/**
 * Standalone app shell — shared layout for all routed views.
 * Renders sidebar, header, dialogs, and an Outlet for route content.
 *
 * This is the `component` for the pathless `_shell` layout route.
 * All route pages (DashboardPage, SessionPage) render inside the Outlet.
 */
export function AppShell() {
  const { sidebarOpen, setSidebarOpen } = useAppStore();
  const [activeSessionId] = useSessionId();
  useDefaultCwd();

  const [selectedCwd] = useDirectoryState();
  const isStreaming = useAppStore((s) => s.isStreaming);
  const activeForm = useAppStore((s) => s.activeForm);
  const isWaitingForUser = useAppStore((s) => s.isWaitingForUser);
  const pulseBadgeCount = useAppStore((s) => s.pulseBadgeCount);
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
    agentName: currentAgent?.name,
    agentEmoji: currentAgent ? agentVisual.emoji : undefined,
    pulseBadgeCount,
  });

  useShortcutsPanel();

  // First-run onboarding — gate rendering until config is loaded to prevent
  // a flash of the chat UI before the onboarding screen appears.
  const { shouldShowOnboarding, isLoading: isOnboardingLoading } = useOnboarding();
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
                <PermissionBanner sessionId={activeSessionId} />
                <SidebarProvider
                  open={sidebarOpen}
                  onOpenChange={setSidebarOpen}
                  className="flex-1 overflow-hidden"
                  style={{ '--sidebar-width': '20rem' } as React.CSSProperties}
                >
                  <Sidebar variant="floating">
                    <AgentSidebar />
                  </Sidebar>
                  <SidebarInset className="overflow-hidden">
                    <header
                      className="relative flex h-9 shrink-0 items-center gap-2 border-b px-2 transition-[border-color] duration-300"
                      style={
                        currentAgent
                          ? {
                              borderBottomColor: `color-mix(in srgb, ${agentVisual.color} 25%, var(--border))`,
                            }
                          : undefined
                      }
                    >
                      <SidebarTrigger className="-ml-0.5" />
                      <Separator orientation="vertical" className="mr-1 h-4" />
                      <AgentIdentityChip
                        agent={currentAgent}
                        visual={agentVisual}
                        isStreaming={isStreaming}
                      />
                      <div className="flex-1" />
                      <CommandPaletteTrigger />
                    </header>
                    <main className="flex-1 overflow-hidden">
                      <Outlet />
                    </main>
                  </SidebarInset>
                </SidebarProvider>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <DialogHost />
        <CommandPaletteDialog />
        <ShortcutsPanel />
        <Toaster />
      </MotionConfig>
    </TooltipProvider>
  );
}
