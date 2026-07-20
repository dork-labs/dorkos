import { useMemo } from 'react';
import { useSessions, sessionDisplayTitle } from '@/layers/entities/session';
import { useTaskRuns } from '@/layers/entities/tasks';
import { useAggregatedDeadLetters } from '@/layers/entities/relay';
import { useMeshStatus } from '@/layers/entities/mesh';
import { useNow } from '@/layers/shared/model';
import { useNavigate } from '@tanstack/react-router';
import type { LucideIcon } from 'lucide-react';
import { Clock, XCircle, Mail, WifiOff } from 'lucide-react';

/** Thirty minutes in milliseconds — sessions not updated within this window are considered stalled. */
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

/** Twenty-four hours in milliseconds — the lookback window for stalled sessions and failed runs. */
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/** Maximum number of attention items displayed in the section. */
const MAX_ITEMS = 8;

export interface AttentionItem {
  id: string;
  type: 'stalled-session' | 'failed-run' | 'dead-letter' | 'offline-agent';
  icon: LucideIcon;
  title: string;
  description: string;
  timestamp: string;
  action: {
    label: string;
    onClick: () => void;
  };
  severity: 'warning' | 'error';
}

/** The attention items plus whether their backing queries are still cold-loading. */
export interface AttentionState {
  /** The derived attention items, sorted most-recent-first and capped. */
  items: AttentionItem[];
  /**
   * True while any backing query is still on its first load (no data yet), so a
   * consumer can withhold an "all clear" until the data that would justify it has
   * actually arrived — otherwise the reassurance flashes before an item pops in.
   * Uses each query's `isLoading` (first-load-in-progress), not raw `isPending`,
   * so a feature-gated/disabled query never wedges this true.
   */
  isLoading: boolean;
}

/**
 * Derive attention items requiring user action from multiple entity hooks.
 * Sources: stalled sessions (>30min idle), failed Tasks runs (last 24h),
 * Relay dead letters, and offline Mesh agents.
 * Items are sorted by timestamp, most recent first.
 *
 * Returns the items alongside an aggregated {@link AttentionState.isLoading} so a
 * consumer that shows an empty/all-clear state can gate it on the data having
 * loaded (the dashboard section, which renders nothing when empty, ignores it).
 */
export function useAttentionItems(): AttentionState {
  const { sessions, isLoading: sessionsLoading } = useSessions();
  const { data: failedRuns, isLoading: failedRunsLoading } = useTaskRuns({ status: 'failed' });
  const { data: deadLetters, isLoading: deadLettersLoading } = useAggregatedDeadLetters();
  const { data: meshStatus, isLoading: meshLoading } = useMeshStatus();
  const navigate = useNavigate();
  const now = useNow();

  const isLoading = Boolean(
    sessionsLoading || failedRunsLoading || deadLettersLoading || meshLoading
  );

  const items = useMemo(() => {
    const items: AttentionItem[] = [];
    const twentyFourHoursAgo = now - TWENTY_FOUR_HOURS_MS;
    const thirtyMinutesAgo = now - THIRTY_MINUTES_MS;

    // Stalled sessions: updated >30min ago but within last 24h (proxy for waiting/stalled state)
    if (sessions) {
      for (const session of sessions) {
        const updatedAt = new Date(session.updatedAt).getTime();
        if (updatedAt < thirtyMinutesAgo && updatedAt > twentyFourHoursAgo) {
          const minutesAgo = Math.floor((now - updatedAt) / 60000);
          const sessionTitle = sessionDisplayTitle(session.title);
          items.push({
            id: `stalled-${session.id}`,
            type: 'stalled-session',
            icon: Clock,
            title: `Session "${sessionTitle}" idle`,
            description: `Session idle for ${minutesAgo} minutes`,
            timestamp: session.updatedAt,
            action: {
              label: 'Open →',
              onClick: () =>
                navigate({
                  to: '/session',
                  search: { session: session.id, dir: session.cwd ?? '' },
                }),
            },
            severity: 'warning',
          });
        }
      }
    }

    // Failed Tasks runs from last 24h
    if (failedRuns) {
      for (const run of failedRuns) {
        const runTime = new Date(run.createdAt).getTime();
        if (runTime > twentyFourHoursAgo) {
          items.push({
            id: `failed-${run.id}`,
            type: 'failed-run',
            icon: XCircle,
            title: `Tasks run failed`,
            description: `Tasks run ${run.id.slice(0, 8)} failed`,
            timestamp: run.createdAt,
            action: {
              label: 'View →',
              onClick: () =>
                navigate({
                  to: '/',
                  search: { detail: 'failed-run', itemId: run.id },
                }),
            },
            severity: 'error',
          });
        }
      }
    }

    // Dead Relay letters with count > 0
    if (deadLetters) {
      for (const group of deadLetters) {
        if (group.count > 0) {
          items.push({
            id: `dead-letter-${group.source}-${group.reason}`,
            type: 'dead-letter',
            icon: Mail,
            title: `${group.count} undeliverable Relay message${group.count === 1 ? '' : 's'}`,
            description: `Dead letters: ${group.source} — ${group.reason}`,
            timestamp: group.lastSeen,
            action: {
              label: 'View →',
              onClick: () =>
                navigate({
                  to: '/',
                  search: { detail: 'dead-letter', itemId: `${group.source}::${group.reason}` },
                }),
            },
            severity: 'warning',
          });
        }
      }
    }

    // Offline Mesh agents
    if (meshStatus && meshStatus.unreachableCount > 0) {
      const count = meshStatus.unreachableCount;
      items.push({
        id: 'offline-agents',
        type: 'offline-agent',
        icon: WifiOff,
        title: `${count} agent${count > 1 ? 's' : ''} offline`,
        description: `${count} mesh agent${count > 1 ? 's' : ''} unreachable`,
        timestamp: new Date(now).toISOString(),
        action: {
          label: 'View →',
          onClick: () =>
            navigate({
              to: '/',
              search: { detail: 'offline-agent', itemId: 'offline' },
            }),
        },
        severity: 'error',
      });
    }

    // Sort by timestamp, most recent first
    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return items.slice(0, MAX_ITEMS);
  }, [now, sessions, failedRuns, deadLetters, meshStatus, navigate]);

  return { items, isLoading };
}
