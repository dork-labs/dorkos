import { useEffect, useRef, useState, useCallback } from 'react';
import { useAppStore, useFavicon, useDocumentTitle } from '@/layers/shared/model';
import { isMac } from '@/layers/shared/lib';
import { useSessionId, useDefaultCwd, useDirectoryState } from '@/layers/entities/session';
import { useCurrentAgent, useAgentVisual } from '@/layers/entities/agent';
import { motion, AnimatePresence, MotionConfig } from 'motion/react';
import { PanelLeft } from 'lucide-react';
import { PermissionBanner, DialogHost } from '@/layers/widgets/app-layout';
import { AgentSidebar } from '@/layers/features/session-list';
import { ChatPanel } from '@/layers/features/chat';
import { useOnboarding, OnboardingFlow } from '@/layers/features/onboarding';
import { AgentIdentityChip, CommandPaletteTrigger } from '@/layers/features/top-nav';
import {
  Toaster,
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  ScanLine,
  Separator,
  Sidebar,
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from '@/layers/shared/ui';
import { Kbd } from '@/layers/shared/ui/kbd';
import { CommandPaletteDialog } from '@/layers/features/command-palette';
import { ShortcutsPanel, useShortcutsPanel } from '@/layers/features/shortcuts';

interface AppProps {
  /** Optional transform applied to message content before sending to server */
  transformContent?: (content: string) => string | Promise<string>;
  /** When true, hides sidebar and uses container-relative sizing (for Obsidian) */
  embedded?: boolean;
}

/** Root application shell with sidebar, chat panel, and session routing. */
export function App({ transformContent, embedded }: AppProps = {}) {
  const { sidebarOpen, setSidebarOpen, toggleSidebar } = useAppStore();
  const [activeSessionId] = useSessionId();
  const containerRef = useRef<HTMLDivElement>(null);
  useDefaultCwd();

  const [selectedCwd] = useDirectoryState();
  const isStreaming = useAppStore((s) => s.isStreaming);
  const isTextStreaming = useAppStore((s) => s.isTextStreaming);
  const activeForm = useAppStore((s) => s.activeForm);
  const isWaitingForUser = useAppStore((s) => s.isWaitingForUser);
  const pulseBadgeCount = useAppStore((s) => s.pulseBadgeCount);
  const { data: currentAgent } = useCurrentAgent(embedded ? null : selectedCwd);
  const agentVisual = useAgentVisual(currentAgent ?? null, selectedCwd ?? '');
  useFavicon({
    cwd: embedded ? null : selectedCwd,
    isStreaming,
    color: currentAgent ? agentVisual.color : undefined,
  });
  useDocumentTitle({
    cwd: embedded ? null : selectedCwd,
    activeForm,
    isStreaming,
    isWaitingForUser,
    agentName: currentAgent?.name,
    agentEmoji: currentAgent ? agentVisual.emoji : undefined,
    pulseBadgeCount,
  });

  useShortcutsPanel(); // Register ? key handler

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

  // Escape key closes overlay sidebar — embedded only (scoped to container)
  // Standalone uses SidebarProvider's built-in Sheet dismiss on mobile
  useEffect(() => {
    if (!embedded) return;
    if (!sidebarOpen) return;
    const target = containerRef.current;
    if (!target) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    target.addEventListener('keydown', handleEscape as EventListener);
    return () => target.removeEventListener('keydown', handleEscape as EventListener);
  }, [embedded, sidebarOpen, setSidebarOpen]);

  // Cmd+B / Ctrl+B toggles sidebar — embedded only (scoped to container)
  // Standalone uses SidebarProvider's built-in keyboard shortcut
  useEffect(() => {
    if (!embedded) return;
    const target = containerRef.current;
    if (!target) return;
    const handleToggle = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    target.addEventListener('keydown', handleToggle as EventListener);
    return () => target.removeEventListener('keydown', handleToggle as EventListener);
  }, [embedded, toggleSidebar]);

  // Embedded mode: overlay sidebar (absolute positioning, scoped to container)
  if (embedded) {
    return (
      <TooltipProvider>
        <MotionConfig reducedMotion="user">
          <div
            ref={containerRef}
            data-testid="app-shell"
            className="bg-background text-foreground relative flex h-full flex-col"
          >
            <PermissionBanner sessionId={activeSessionId} />
            <div className="relative flex-1 overflow-hidden">
              {/* Overlay sidebar — always uses overlay pattern in embedded mode */}
              <AnimatePresence>
                {sidebarOpen && (
                  <>
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="absolute inset-0 z-40 bg-black/40"
                      onClick={() => setSidebarOpen(false)}
                      aria-label="Close sidebar"
                    />
                    <motion.div
                      initial={{ x: -320 }}
                      animate={{ x: 0 }}
                      exit={{ x: -320 }}
                      transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
                      className="bg-background absolute top-0 left-0 z-50 h-full w-80 overflow-y-auto border-r"
                    >
                      <AgentSidebar />
                    </motion.div>
                  </>
                )}
              </AnimatePresence>

              {/* Floating toggle — visible when sidebar is closed */}
              <AnimatePresence>
                {!sidebarOpen && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <motion.button
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
                        onClick={toggleSidebar}
                        className="bg-background/80 hover:bg-accent absolute top-3 left-3 z-30 rounded-md border p-1.5 shadow-sm backdrop-blur transition-colors duration-150"
                        aria-label="Open sidebar"
                      >
                        <PanelLeft className="size-(--size-icon-md)" />
                      </motion.button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      Toggle sidebar <Kbd>{isMac ? '⌘B' : 'Ctrl+B'}</Kbd>
                    </TooltipContent>
                  </Tooltip>
                )}
              </AnimatePresence>

              <main className="h-full flex-1 overflow-hidden">
                <ChatPanel
                  sessionId={activeSessionId}
                  transformContent={transformContent}
                />
              </main>
            </div>
          </div>
          <CommandPaletteDialog />
          <ShortcutsPanel />
          <Toaster />
        </MotionConfig>
      </TooltipProvider>
    );
  }

  // Standalone mode: Shadcn SidebarProvider handles layout, Sheet on mobile, push on desktop
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
              <div data-testid="app-shell" className="bg-background text-foreground flex h-dvh flex-col">
                <PermissionBanner sessionId={activeSessionId} />
                <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen} className="flex-1 overflow-hidden" style={{ "--sidebar-width": "20rem" } as React.CSSProperties}>
                  <Sidebar variant="floating">
                    <AgentSidebar />
                  </Sidebar>
                  <SidebarInset className="overflow-hidden">
                    <header
                      className="relative flex h-9 shrink-0 items-center gap-2 border-b px-2 transition-[border-color] duration-300"
                      style={currentAgent ? {
                        borderBottomColor: `color-mix(in srgb, ${agentVisual.color} 25%, var(--border))`,
                      } : undefined}
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

                      {/* Streaming scan line — sweeps across header bottom when agent is active */}
                      <AnimatePresence>
                        {isStreaming && (
                          <ScanLine color={agentVisual.color} isTextStreaming={isTextStreaming} />
                        )}
                      </AnimatePresence>
                    </header>
                    <main className="flex-1 overflow-hidden">
                      <ChatPanel
                        sessionId={activeSessionId}
                        transformContent={transformContent}
                      />
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
