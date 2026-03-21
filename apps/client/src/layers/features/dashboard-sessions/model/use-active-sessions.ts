import { useMemo } from 'react';
import { useSessions } from '@/layers/entities/session';
import { useResolvedAgents } from '@/layers/entities/agent';

/** Two hours in milliseconds — sessions not updated within this window are excluded. */
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/** Five minutes in milliseconds — sessions updated within this window are considered active. */
const FIVE_MINUTES_MS = 5 * 60 * 1000;

/** Maximum number of session cards to display on the dashboard. */
const MAX_SESSIONS = 6;

export interface ActiveSession {
  id: string;
  title: string;
  cwd: string;
  agentName: string;
  agentEmoji: string;
  agentColor: string;
  lastActivity: string;
  elapsedTime: string;
  status: 'active' | 'idle';
}

/**
 * Filter and enrich recently active sessions with agent identity.
 * Sessions updated within 2 hours are included; capped at 6.
 */
export function useActiveSessions(): { sessions: ActiveSession[]; totalCount: number } {
  const { sessions: allSessions } = useSessions();

  const recentSessions = useMemo(() => {
    if (!allSessions) return [];
    const twoHoursAgo = Date.now() - TWO_HOURS_MS;
    return allSessions.filter((s) => new Date(s.updatedAt).getTime() > twoHoursAgo);
  }, [allSessions]);

  const uniquePaths = useMemo(
    () => [...new Set(recentSessions.map((s) => s.cwd ?? '').filter(Boolean))],
    [recentSessions]
  );

  const { data: agents } = useResolvedAgents(uniquePaths);

  const sessions = useMemo(() => {
    const fiveMinutesAgo = Date.now() - FIVE_MINUTES_MS;
    return recentSessions
      .map((session) => {
        const cwd = session.cwd ?? '';
        const agent = cwd ? (agents?.[cwd] ?? null) : null;
        const updatedTime = new Date(session.updatedAt).getTime();
        const createdTime = new Date(session.createdAt).getTime();
        const elapsed = Date.now() - createdTime;
        return {
          id: session.id,
          title: session.title ?? session.id,
          cwd,
          agentName: agent?.name ?? cwd.split('/').pop() ?? 'Agent',
          agentEmoji: agent?.icon ?? '',
          agentColor: agent?.color ?? '',
          lastActivity: session.lastMessagePreview ?? '',
          elapsedTime: formatElapsed(elapsed),
          status: updatedTime > fiveMinutesAgo ? ('active' as const) : ('idle' as const),
        } satisfies ActiveSession;
      })
      .slice(0, MAX_SESSIONS);
  }, [recentSessions, agents]);

  return { sessions, totalCount: recentSessions.length };
}

/** @internal Exported for testing only. */
export function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}
