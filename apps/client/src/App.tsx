import { useEffect, useRef } from 'react';
import { useAppStore, useFavicon, useDocumentTitle } from '@/layers/shared/model';
import { isMac } from '@/layers/shared/lib';
import { useSessionId, useDefaultCwd, useDirectoryState } from '@/layers/entities/session';
import { useCurrentAgent, useAgentVisual } from '@/layers/entities/agent';
import { motion, AnimatePresence, MotionConfig } from 'motion/react';
import { PanelLeft } from 'lucide-react';
import { PermissionBanner } from '@/layers/widgets/app-layout';
import { SessionSidebar } from '@/layers/features/session-list';
import { ChatPanel } from '@/layers/features/chat';
import {
  Toaster,
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/layers/shared/ui';
import { Kbd } from '@/layers/shared/ui/kbd';
import { CommandPaletteDialog } from '@/layers/features/command-palette';
import { ShortcutsPanel, useShortcutsPanel } from '@/layers/features/shortcuts';

interface AppProps {
  /** Optional transform applied to message content before sending to server */
  transformContent?: (content: string) => string | Promise<string>;
}

/**
 * Embedded application shell for the Obsidian plugin.
 *
 * Renders an overlay sidebar, floating toggle, and ChatPanel within
 * a container-relative layout. No router — session state is managed
 * entirely via Zustand. The standalone web app uses {@link AppShell} instead.
 */
export function App({ transformContent }: AppProps) {
  const { sidebarOpen, setSidebarOpen, toggleSidebar } = useAppStore();
  const [activeSessionId] = useSessionId();
  const containerRef = useRef<HTMLDivElement>(null);
  useDefaultCwd();

  const [selectedCwd] = useDirectoryState();
  const isStreaming = useAppStore((s) => s.isStreaming);
  const activeForm = useAppStore((s) => s.activeForm);
  const isWaitingForUser = useAppStore((s) => s.isWaitingForUser);
  const pulseBadgeCount = useAppStore((s) => s.pulseBadgeCount);
  const { data: currentAgent } = useCurrentAgent(null);
  const agentVisual = useAgentVisual(currentAgent ?? null, selectedCwd ?? '');
  useFavicon({ cwd: null, isStreaming, color: currentAgent ? agentVisual.color : undefined });
  useDocumentTitle({
    cwd: null,
    activeForm,
    isStreaming,
    isWaitingForUser,
    agentName: currentAgent?.name,
    agentEmoji: currentAgent ? agentVisual.emoji : undefined,
    pulseBadgeCount,
  });

  useShortcutsPanel();

  // Escape key closes overlay sidebar (scoped to container)
  useEffect(() => {
    if (!sidebarOpen) return;
    const target = containerRef.current;
    if (!target) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    target.addEventListener('keydown', handleEscape as EventListener);
    return () => target.removeEventListener('keydown', handleEscape as EventListener);
  }, [sidebarOpen, setSidebarOpen]);

  // Cmd+B / Ctrl+B toggles sidebar (scoped to container)
  useEffect(() => {
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
  }, [toggleSidebar]);

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
                    <SessionSidebar />
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
              <ChatPanel sessionId={activeSessionId} transformContent={transformContent} />
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
