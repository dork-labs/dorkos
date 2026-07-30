import { motion } from 'motion/react';
import { CircleAlert } from 'lucide-react';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  ScrollArea,
} from '@/layers/shared/ui';
import { useClaudeAccounts } from '@/layers/shared/model';
import { SessionRow } from '@/layers/entities/session';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import type { Session, SessionListWarning } from '@dorkos/shared/types';
import { FleetContextBar } from './FleetContextBar';

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
 * Identity of one warning: the runtime, plus the account when the failure
 * belongs to a single Claude account rather than the whole runtime.
 *
 * Claude Code reads one store per account and pushes one warning per unreadable
 * account, all tagged `runtime: 'claude-code'` — so the runtime alone is NOT an
 * identity. Keyed by it, two unreadable accounts produced duplicate React keys
 * and duplicate test ids (spec `claude-code-accounts`).
 */
function warningKey(warning: SessionListWarning): string {
  return warning.account ? `${warning.runtime}-${warning.account}` : warning.runtime;
}

/**
 * Quiet inline notice for one store whose sessions could not be listed.
 *
 * Names whatever failed: the account when one Claude account is unreadable and
 * the others still list, the runtime when the whole backend is down. Two notices
 * therefore read as two different problems. The server's failure reason rides the
 * tooltip so the line stays a single calm sentence ("OpenCode server is
 * starting…" class detail on hover).
 */
function SessionListWarningNotice({ warning }: { warning: SessionListWarning }) {
  const { nameFor } = useClaudeAccounts();
  const runtimeLabel = getRuntimeDescriptor(warning.runtime).label;
  const subject = warning.account
    ? `${runtimeLabel} sessions from ${nameFor(warning.account)}`
    : `${runtimeLabel} sessions`;
  return (
    <p
      className="text-muted-foreground/60 flex items-start gap-1.5 text-xs"
      title={warning.message}
      data-testid={`session-list-warning-${warningKey(warning)}`}
    >
      <CircleAlert className="mt-px size-3 shrink-0" aria-hidden />
      <span>Couldn&apos;t load {subject}</span>
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
            <SessionListWarningNotice key={warningKey(warning)} warning={warning} />
          ))}
        </div>
      )}
      {/* Fleet-level context health — complements the per-runtime warnings above
          and hides itself when there is nothing to report (spec §8b). */}
      <FleetContextBar />
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
