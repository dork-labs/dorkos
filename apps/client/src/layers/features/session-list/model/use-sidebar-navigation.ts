import { useCallback, useEffect, useContext } from 'react';
import { useAppStore, useIsMobile } from '@/layers/shared/model';
import { TIMING } from '@/layers/shared/lib';
import { SidebarContext } from '@/layers/shared/ui';
import { useSessions } from '@/layers/entities/session';

interface SidebarNavigationResult {
  /** Navigate to a new session with a fresh UUID. */
  handleNewSession: () => void;
  /** Navigate to an existing session by ID. */
  handleSessionClick: (sessionId: string) => void;
  /** Navigate back to the dashboard. */
  handleDashboard: () => void;
}

/**
 * Session sidebar navigation callbacks with mobile auto-close.
 *
 * Consolidates the repeated pattern of navigating + closing the mobile sidebar
 * into a single hook. Also registers the global Cmd/Ctrl+Shift+N shortcut.
 */
export function useSidebarNavigation(): SidebarNavigationResult {
  const { setActiveSession } = useSessions();
  const { setSidebarOpen } = useAppStore();
  const isMobile = useIsMobile();
  // Null when rendered in embedded mode (no SidebarProvider); used to close the mobile Sheet.
  const sidebarCtx = useContext(SidebarContext);

  const closeMobileSidebar = useCallback(
    (delay = false) => {
      if (!isMobile) return;
      const close = () => {
        setSidebarOpen(false);
        sidebarCtx?.setOpenMobile(false);
      };
      if (delay) {
        setTimeout(close, TIMING.SIDEBAR_AUTO_CLOSE_MS);
      } else {
        close();
      }
    },
    [isMobile, setSidebarOpen, sidebarCtx]
  );

  const handleNewSession = useCallback(() => {
    setActiveSession(crypto.randomUUID());
    closeMobileSidebar(true);
  }, [setActiveSession, closeMobileSidebar]);

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      setActiveSession(sessionId);
      closeMobileSidebar();
    },
    [setActiveSession, closeMobileSidebar]
  );

  const setSidebarLevel = useAppStore((s) => s.setSidebarLevel);

  const handleDashboard = useCallback(() => {
    setSidebarLevel('dashboard');
    closeMobileSidebar();
  }, [setSidebarLevel, closeMobileSidebar]);

  // Cmd/Ctrl+Shift+N → new session (global, works regardless of sidebar state)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        handleNewSession();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleNewSession]);

  return { handleNewSession, handleSessionClick, handleDashboard };
}
