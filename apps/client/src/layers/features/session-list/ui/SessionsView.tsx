import { motion } from 'motion/react';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  ScrollArea,
} from '@/layers/shared/ui';
import { SessionItem } from './SessionItem';
import type { Session } from '@dorkos/shared/types';

interface SessionGroup {
  label: string;
  sessions: Session[];
}

interface SessionsViewProps {
  activeSessionId: string | null;
  groupedSessions: SessionGroup[];
  onSessionClick: (sessionId: string) => void;
  onForkSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, title: string) => void;
}

/** Read-only session list view for the sidebar Sessions tab. */
export function SessionsView({
  activeSessionId,
  groupedSessions,
  onSessionClick,
  onForkSession,
  onRenameSession,
}: SessionsViewProps) {
  return (
    <ScrollArea type="scroll" className="h-full" viewportClassName="[&>div]:!block">
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
