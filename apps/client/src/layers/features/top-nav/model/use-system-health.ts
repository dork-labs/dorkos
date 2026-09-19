import { useMemo } from 'react';
import { useTaskRuns } from '@/layers/entities/tasks';
import { useAggregatedDeadLetters, useRelayAdapters } from '@/layers/entities/relay';
import { useMeshStatus } from '@/layers/entities/mesh';
import { useNow } from '@/layers/shared/model';

/** One day in milliseconds. */
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export type SystemHealthState = 'healthy' | 'degraded' | 'error';

/**
 * Derive system health state from entity hook data.
 *
 * Priority: `error` > `degraded` > `healthy`.
 * Error conditions: failed or blocked Tasks runs in last 24h, dead letters,
 * unreachable mesh agents. A blocked run counts (DOR-2101): a schedule that is
 * turned down at every tool it reaches for does nothing, every night, and the
 * health chip staying green over it is the same silence the run row used to
 * keep.
 * Degraded condition: any relay adapter disconnected but no error conditions.
 */
export function useSystemHealth(): SystemHealthState {
  const { data: failedRuns } = useTaskRuns({ status: 'failed' });
  const { data: blockedRuns } = useTaskRuns({ status: 'blocked' });
  const { data: deadLetters } = useAggregatedDeadLetters();
  const { data: meshStatus } = useMeshStatus();
  const { data: adapters } = useRelayAdapters();

  const now = useNow();

  return useMemo(() => {
    const twentyFourHoursAgo = now - TWENTY_FOUR_HOURS_MS;

    const isRecent = (run: { createdAt: string }): boolean =>
      new Date(run.createdAt).getTime() > twentyFourHoursAgo;
    const hasRecentFailedRuns = failedRuns?.some(isRecent) || blockedRuns?.some(isRecent);
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
  }, [now, failedRuns, blockedRuns, deadLetters, meshStatus, adapters]);
}
