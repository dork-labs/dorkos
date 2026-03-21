import { useMemo } from 'react';
import { useSessions } from '@/layers/entities/session';
import { useRuns } from '@/layers/entities/pulse';
import { useAggregatedDeadLetters } from '@/layers/entities/relay';
import { useMeshStatus } from '@/layers/entities/mesh';
import { useNavigate } from '@tanstack/react-router';
import { useAppStore } from '@/layers/shared/model';
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

/**
 * Derive attention items requiring user action from multiple entity hooks.
 * Sources: stalled sessions (>30min idle), failed Pulse runs (last 24h),
 * Relay dead letters, and offline Mesh agents.
 * Items are sorted by timestamp, most recent first.
 */
export function useAttentionItems(): AttentionItem[] {
  const { sessions } = useSessions();
  const { data: failedRuns } = useRuns({ status: 'failed' });
  const { data: deadLetters } = useAggregatedDeadLetters();
  const { data: meshStatus } = useMeshStatus();
  const navigate = useNavigate();
  const setRelayOpen = useAppStore((s) => s.setRelayOpen);
  const setMeshOpen = useAppStore((s) => s.setMeshOpen);
  const setPulseOpen = useAppStore((s) => s.setPulseOpen);

  return useMemo(() => {
    const items: AttentionItem[] = [];
    const now = Date.now();
    const twentyFourHoursAgo = now - TWENTY_FOUR_HOURS_MS;
    const thirtyMinutesAgo = now - THIRTY_MINUTES_MS;

    // Stalled sessions: updated >30min ago but within last 24h (proxy for waiting/stalled state)
    if (sessions) {
      for (const session of sessions) {
        const updatedAt = new Date(session.updatedAt).getTime();
        if (updatedAt < thirtyMinutesAgo && updatedAt > twentyFourHoursAgo) {
          const minutesAgo = Math.floor((now - updatedAt) / 60000);
          const sessionTitle = session.title ?? session.id.slice(0, 8);
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

    // Failed Pulse runs from last 24h
    if (failedRuns) {
      for (const run of failedRuns) {
        const runTime = new Date(run.createdAt).getTime();
        if (runTime > twentyFourHoursAgo) {
          items.push({
            id: `failed-${run.id}`,
            type: 'failed-run',
            icon: XCircle,
            title: `Pulse run failed`,
            description: `Pulse run ${run.id.slice(0, 8)} failed`,
            timestamp: run.createdAt,
            action: {
              label: 'View →',
              onClick: () => setPulseOpen(true),
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
              onClick: () => setRelayOpen(true),
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
        timestamp: new Date().toISOString(),
        action: {
          label: 'View →',
          onClick: () => setMeshOpen(true),
        },
        severity: 'error',
      });
    }

    // Sort by timestamp, most recent first
    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return items.slice(0, MAX_ITEMS);
  }, [
    sessions,
    failedRuns,
    deadLetters,
    meshStatus,
    navigate,
    setRelayOpen,
    setMeshOpen,
    setPulseOpen,
  ]);
}
