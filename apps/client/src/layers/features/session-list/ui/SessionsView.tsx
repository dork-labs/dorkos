import { motion } from 'motion/react';
import { CircleAlert } from 'lucide-react';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  ScrollArea,
} from '@/layers/shared/ui';
import { SessionRow } from '@/layers/entities/session';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import type { Session, SessionListWarning } from '@dorkos/shared/types';

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

/**
 * Quiet inline notice for one runtime whose sessions could not be listed.
 * Names the runtime; the server's failure reason rides the tooltip so the
 * line stays a single calm sentence ("OpenCode server is starting…" class
 * detail on hover).
 */
function SessionListWarningNotice({ warning }: { warning: SessionListWarning }) {
  const label = getRuntimeDescriptor(warning.runtime).label;
  return (
    <p
      className="text-muted-foreground/60 flex items-start gap-1.5 text-xs"
      title={warning.message}
      data-testid={`session-list-warning-${warning.runtime}`}
    >
      <CircleAlert className="mt-px size-3 shrink-0" aria-hidden />
      <span>Couldn&apos;t load {label} sessions</span>
    </p>
  );
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
  return (
    <ScrollArea type="scroll" className="h-full" viewportClassName="[&>div]:!block">
      {warnings.length > 0 && (
        <div className="space-y-1 px-4 pt-2" data-testid="session-list-warnings">
          {warnings.map((warning) => (
            <SessionListWarningNotice key={warning.runtime} warning={warning} />
          ))}
        </div>
      )}
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
      </motion.div>
    </ScrollArea>
  );
}
