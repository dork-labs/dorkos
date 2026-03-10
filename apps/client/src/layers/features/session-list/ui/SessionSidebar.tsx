import { useState, useMemo, useCallback, useEffect, useRef, useContext } from 'react';
import { motion } from 'motion/react';
import { useAppStore, useIsMobile } from '@/layers/shared/model';
import { groupSessionsByTime, TIMING } from '@/layers/shared/lib';
import {
  SidebarContent,
  SidebarContext,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarRail,
} from '@/layers/shared/ui';
import { usePulseEnabled, useCompletedRunBadge } from '@/layers/entities/pulse';
import { toast } from 'sonner';
import { useSessions } from '@/layers/entities/session';
import { SessionItem } from './SessionItem';
import { AgentContextChips } from './AgentContextChips';
import { SidebarFooterBar } from './SidebarFooterBar';
import { Plus } from 'lucide-react';
import { ScrollArea } from '@/layers/shared/ui';
import { ProgressCard, useOnboarding } from '@/layers/features/onboarding';
import type { Session } from '@dorkos/shared/types';

export function SessionSidebar() {
  const { sessions, activeSessionId, setActiveSession } = useSessions();
  const { setSidebarOpen, setPulseOpen, setOnboardingStep } =
    useAppStore();
  const isMobile = useIsMobile();
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  // Suppresses auto-select after user intentionally clicks "New session"
  const intentionallyNullRef = useRef(false);
  const pulseEnabled = usePulseEnabled();
  const { unviewedCount, clearBadge } = useCompletedRunBadge(pulseEnabled);
  const enablePulseNotifications = useAppStore((s) => s.enablePulseNotifications);
  const { shouldShowOnboarding, dismiss: dismissOnboarding } = useOnboarding();
  const pulseOpen = useAppStore((s) => s.pulseOpen);
  // Null when rendered in embedded mode (no SidebarProvider); used to close the mobile Sheet.
  const sidebarCtx = useContext(SidebarContext);

  // Auto-select most recent session when directory changes and no session is active.
  // Skip when the user intentionally cleared the session via "New session" button.
  useEffect(() => {
    if (intentionallyNullRef.current) {
      intentionallyNullRef.current = false;
      return;
    }
    if (!activeSessionId && sessions.length > 0) {
      setActiveSession(sessions[0].id);
    }
  }, [activeSessionId, sessions, setActiveSession]);

  const handleNewSession = useCallback(() => {
    intentionallyNullRef.current = true;
    setActiveSession(null);
    if (isMobile) {
      setTimeout(() => {
        setSidebarOpen(false);
        sidebarCtx?.setOpenMobile(false);
      }, TIMING.SIDEBAR_AUTO_CLOSE_MS);
    }
  }, [setActiveSession, isMobile, setSidebarOpen, sidebarCtx]);

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      setActiveSession(sessionId);
      if (isMobile) {
        setSidebarOpen(false);
        sidebarCtx?.setOpenMobile(false);
      }
    },
    [isMobile, setActiveSession, setSidebarOpen, sidebarCtx]
  );

  // Clear completion badge when Pulse panel opens
  useEffect(() => {
    if (pulseOpen) clearBadge();
  }, [pulseOpen, clearBadge]);

  // Toast on new run completions
  const prevUnviewedRef = useRef(0);
  useEffect(() => {
    if (!enablePulseNotifications) return;
    if (unviewedCount > prevUnviewedRef.current) {
      toast('Pulse run completed', {
        description: 'A scheduled run has finished.',
        duration: 6000,
        action: {
          label: 'View history',
          onClick: () => setPulseOpen(true),
        },
      });
    }
    prevUnviewedRef.current = unviewedCount;
  }, [unviewedCount, enablePulseNotifications, setPulseOpen]);

  // Flow badge count to Zustand so useDocumentTitle can render it
  const setPulseBadgeCount = useAppStore((s) => s.setPulseBadgeCount);
  useEffect(() => {
    setPulseBadgeCount(unviewedCount);
    return () => setPulseBadgeCount(0);
  }, [unviewedCount, setPulseBadgeCount]);

  const groupedSessions = useMemo(() => groupSessionsByTime(sessions), [sessions]);

  return (
    <>
      <SidebarHeader className="border-b p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={handleNewSession}
              className="border-border text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all duration-100 active:scale-[0.98] disabled:opacity-50"
            >
              <Plus className="size-(--size-icon-sm)" />
              New session
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent data-testid="session-list" className="!overflow-hidden">
        <ScrollArea type="scroll" className="h-full">
        <motion.div layout>
        {groupedSessions.length > 0 ? (
          <>
            {groupedSessions.map((group) => {
              const hideHeader = groupedSessions.length === 1 && group.label === 'Today';
              return (
                <SidebarGroup key={group.label}>
                  {!hideHeader && (
                    <SidebarGroupLabel className="text-2xs text-muted-foreground/70 font-medium tracking-wider uppercase">
                      {group.label}
                    </SidebarGroupLabel>
                  )}
                  <SidebarMenu>
                    {group.sessions.map((session: Session) => (
                      <SidebarMenuItem key={session.id}>
                        <SessionItem
                          session={session}
                          isActive={session.id === activeSessionId}
                          isNew={session.id === justCreatedId}
                          onClick={() => handleSessionClick(session.id)}
                        />
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroup>
              );
            })}
          </>
        ) : (
          <div className="flex h-32 items-center justify-center">
            <p className="text-muted-foreground/60 text-sm">No conversations yet</p>
          </div>
        )}
        </motion.div>
        </ScrollArea>
      </SidebarContent>

      <SidebarFooter className="border-t p-3">
        {shouldShowOnboarding && (
          <div className="mb-2">
            <ProgressCard
              onStepClick={(stepIndex) => setOnboardingStep(stepIndex)}
              onDismiss={dismissOnboarding}
            />
          </div>
        )}
        <AgentContextChips />
        <SidebarFooterBar />
      </SidebarFooter>

      <SidebarRail />
    </>
  );
}
