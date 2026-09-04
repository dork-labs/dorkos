import { useId } from 'react';
import { LayoutGroup, motion } from 'motion/react';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  ScrollArea,
} from '@/layers/shared/ui';
import { SessionRow } from '@/layers/entities/session';
import type { Session, SessionListWarning } from '@dorkos/shared/types';
import { FleetContextBar } from './FleetContextBar';
import { SessionListWarningNotice, warningKey } from './SessionListWarningNotice';

interface SessionGroup {
  label: string;
  sessions: Session[];
}

interface SessionsViewProps {
  activeSessionId: string | null;
  groupedSessions: SessionGroup[];
  /**
   * Per-runtime listing degradations from the aggregated session list
   * (ADR-0310) — a runtime that failed or timed out contributed zero
   * sessions. Rendered as a quiet, non-blocking notice above the list.
   */
  warnings?: SessionListWarning[];
  onSessionClick: (sessionId: string) => void;
  onForkSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, title: string) => void;
}

/** Read-only session list view for the sidebar Sessions tab. */
export function SessionsView({
  activeSessionId,
  groupedSessions,
  warnings = [],
  onSessionClick,
  onForkSession,
  onRenameSession,
}: SessionsViewProps) {
  // Namespaces the active row's shared `layoutId` to THIS list, so a second
  // session list mounted anywhere could never pull the highlight across to it.
  const rowGroupId = useId();

  return (
    <ScrollArea type="scroll" className="h-full" viewportClassName="[&>div]:!block">
      {warnings.length > 0 && (
        <div className="space-y-1 px-4 pt-2" data-testid="session-list-warnings">
          {warnings.map((warning) => (
            <SessionListWarningNotice key={warningKey(warning)} warning={warning} />
          ))}
        </div>
      )}
      {/* Fleet-level context health — complements the per-runtime warnings above
          and hides itself when there is nothing to report (spec §8b). */}
      <FleetContextBar />
      <motion.div layout>
        <LayoutGroup id={rowGroupId}>
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
                          <SessionRow
                            variant="full"
                            session={session}
                            isActive={session.id === activeSessionId}
                            onClick={() => onSessionClick(session.id)}
                            onFork={onForkSession}
                            onRename={onRenameSession}
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
        </LayoutGroup>
      </motion.div>
    </ScrollArea>
  );
}
