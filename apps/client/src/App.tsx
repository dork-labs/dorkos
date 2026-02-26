import { useEffect, useRef } from 'react';
import { useAppStore, useIsMobile, useFavicon, useDocumentTitle } from '@/layers/shared/model';
import { useSessionId, useDefaultCwd, useDirectoryState } from '@/layers/entities/session';
import { motion, AnimatePresence, MotionConfig } from 'motion/react';
import { PanelLeft } from 'lucide-react';
import { PermissionBanner } from '@/layers/widgets/app-layout';
import { SessionSidebar } from '@/layers/features/session-list';
import { ChatPanel } from '@/layers/features/chat';
import { Toaster, TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '@/layers/shared/ui';
import { Kbd } from '@/layers/shared/ui/kbd';

interface AppProps {
  /** Optional transform applied to message content before sending to server */
  transformContent?: (content: string) => string | Promise<string>;
  /** When true, hides sidebar and uses container-relative sizing (for Obsidian) */
  embedded?: boolean;
}

export function App({ transformContent, embedded }: AppProps = {}) {
  const { sidebarOpen, setSidebarOpen, toggleSidebar } = useAppStore();
  const [activeSessionId] = useSessionId();
  const isMobile = useIsMobile();
  const containerRef = useRef<HTMLDivElement>(null);
  useDefaultCwd();

  const [selectedCwd] = useDirectoryState();
  const isStreaming = useAppStore((s) => s.isStreaming);
  const activeForm = useAppStore((s) => s.activeForm);
  const isWaitingForUser = useAppStore((s) => s.isWaitingForUser);
  useFavicon({ cwd: embedded ? null : selectedCwd, isStreaming });
  useDocumentTitle({
    cwd: embedded ? null : selectedCwd,
    activeForm,
    isStreaming,
    isWaitingForUser,
  });

  // Escape key closes overlay sidebar
  // Embedded: scoped to container element; Standalone: scoped to document
  useEffect(() => {
    const useOverlay = embedded || isMobile;
    if (!useOverlay || !sidebarOpen) return;
    const target = embedded ? containerRef.current : document;
    if (!target) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    target.addEventListener('keydown', handleEscape as EventListener);
    return () => target.removeEventListener('keydown', handleEscape as EventListener);
  }, [embedded, isMobile, sidebarOpen, setSidebarOpen]);

  // Cmd+B / Ctrl+B toggles sidebar
  useEffect(() => {
    const target = embedded ? containerRef.current : document;
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

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

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
                {activeSessionId ? (
                  <ChatPanel
                    key={activeSessionId}
                    sessionId={activeSessionId}
                    transformContent={transformContent}
                  />
                ) : (
                  <div className="flex h-full flex-1 items-center justify-center">
                    <div className="text-center">
                      <p className="text-muted-foreground text-base">New conversation</p>
                      <p className="text-muted-foreground/60 mt-2 text-sm">
                        Select a session or start a new one
                      </p>
                    </div>
                  </div>
                )}
              </main>
            </div>
          </div>
          <Toaster />
        </MotionConfig>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <MotionConfig reducedMotion="user">
        <div ref={containerRef} data-testid="app-shell" className="bg-background text-foreground flex h-dvh flex-col">
          <PermissionBanner sessionId={activeSessionId} />
          <div className="relative flex flex-1 overflow-hidden">
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

            {isMobile ? (
              /* Mobile: overlay sidebar with backdrop */
              <AnimatePresence>
                {sidebarOpen && (
                  <>
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="fixed inset-0 z-40 bg-black/40"
                      onClick={() => setSidebarOpen(false)}
                      aria-label="Close sidebar"
                    />
                    <motion.div
                      initial={{ x: '-90vw' }}
                      animate={{ x: 0 }}
                      exit={{ x: '-90vw' }}
                      transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
                      className="bg-background fixed top-0 left-0 z-50 h-full w-[90vw] overflow-y-auto border-r"
                    >
                      <SessionSidebar />
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            ) : (
              /* Desktop: push sidebar */
              <motion.div
                animate={{ width: sidebarOpen ? 320 : 0 }}
                transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
                className="flex-shrink-0 overflow-hidden border-r"
              >
                <div className="h-full w-80 overflow-y-auto">
                  <SessionSidebar />
                </div>
              </motion.div>
            )}

            <main className="flex-1 overflow-hidden">
              {activeSessionId ? (
                <ChatPanel
                  key={activeSessionId}
                  sessionId={activeSessionId}
                  transformContent={transformContent}
                />
              ) : (
                <div className="flex h-full flex-1 items-center justify-center">
                  <div className="text-center">
                    <p className="text-muted-foreground text-base">New conversation</p>
                    <p className="text-muted-foreground/60 mt-2 text-sm">
                      Select a session or start a new one
                    </p>
                  </div>
                </div>
              )}
            </main>
          </div>
        </div>
        <Toaster />
      </MotionConfig>
    </TooltipProvider>
  );
}
