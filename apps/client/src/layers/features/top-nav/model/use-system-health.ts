import { useMemo } from 'react';
import { useRuns } from '@/layers/entities/pulse';
import { useAggregatedDeadLetters, useRelayAdapters } from '@/layers/entities/relay';
import { useMeshStatus } from '@/layers/entities/mesh';

/** One day in milliseconds. */
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export type SystemHealthState = 'healthy' | 'degraded' | 'error';

/**
 * Derive system health state from entity hook data.
 *
 * Priority: `error` > `degraded` > `healthy`.
 * Error conditions: failed Pulse runs in last 24h, dead letters, unreachable mesh agents.
 * Degraded condition: any relay adapter disconnected but no error conditions.
 */
export function useSystemHealth(): SystemHealthState {
  const { data: failedRuns } = useRuns({ status: 'failed' });
  const { data: deadLetters } = useAggregatedDeadLetters();
  const { data: meshStatus } = useMeshStatus();
  const { data: adapters } = useRelayAdapters();

  return useMemo(() => {
    const now = Date.now();
    const twentyFourHoursAgo = now - TWENTY_FOUR_HOURS_MS;

    const hasRecentFailedRuns = failedRuns?.some(
      (run) => new Date(run.createdAt).getTime() > twentyFourHoursAgo
    );
    const hasDeadLetters = deadLetters?.some((group) => group.count > 0);
    const hasUnreachableAgents = (meshStatus?.unreachableCount ?? 0) > 0;

    if (hasRecentFailedRuns || hasDeadLetters || hasUnreachableAgents) {
      return 'error';
    }

    const hasDisconnectedAdapters = adapters?.some(
      (adapter) => adapter.status?.state !== 'connected'
    );
    if (hasDisconnectedAdapters) {
      return 'degraded';
    }

    return 'healthy';
  }, [failedRuns, deadLetters, meshStatus, adapters]);
}
