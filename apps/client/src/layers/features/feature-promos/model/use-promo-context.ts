import { useCallback } from 'react';
import { useTasks, useTasksEnabled } from '@/layers/entities/tasks';
import { useRelayAdapters, useRelayEnabled } from '@/layers/entities/relay';
import { useSessions } from '@/layers/entities/session';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { useMeshEnabled } from './use-mesh-enabled';
import { useFirstUseDate } from './use-first-use-date';
import type { PromoContext } from './promo-types';

/**
 * Assembles the full PromoContext used by promo shouldShow predicates.
 *
 * Aggregates feature-flag state, adapter availability, session/agent counts,
 * and first-use date into a single stable object.
 */
export function usePromoContext(): PromoContext {
  const isTasksEnabled = useTasksEnabled();
  const isMeshEnabled = useMeshEnabled();
  const isRelayEnabled = useRelayEnabled();
  const { sessions } = useSessions();
  const { data: agentsData } = useRegisteredAgents();
  const daysSinceFirstUse = useFirstUseDate();

  // Fetch adapter list directly to build the hasAdapter predicate.
  // The query is gated on isRelayEnabled so it only runs when Relay is active.
  const { data: adapters } = useRelayAdapters(isRelayEnabled);

  // Gated the same way: a scheduler nobody has switched on has no schedules to
  // count, and a promo that offers to create one has nothing to offer either.
  const { data: tasks } = useTasks(isTasksEnabled);

  // Stable function reference — promo predicates call this synchronously.
  const hasAdapter = useCallback(
    (name: string): boolean => {
      if (!adapters) return false;
      return adapters.some(
        (item) => item.config.type === name && item.status.state === 'connected'
      );
    },
    [adapters]
  );

  return {
    hasAdapter,
    isTasksEnabled,
    isMeshEnabled,
    isRelayEnabled,
    sessionCount: sessions.length,
    agentCount: agentsData?.agents.length ?? 0,
    taskCount: tasks?.length ?? 0,
    daysSinceFirstUse,
  };
}
