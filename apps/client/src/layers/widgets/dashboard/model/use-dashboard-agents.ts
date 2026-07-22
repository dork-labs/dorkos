/**
 * Data for the dashboard "Your agents" cards: the same roster the sidebar
 * consumes (mesh agent paths + shared attention model + recent activity), shaped
 * into ordered card view models. No new endpoints.
 *
 * @module widgets/dashboard/model/use-dashboard-agents
 */
import { useMemo } from 'react';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useAgentAttentionMap, useRecentSessions } from '@/layers/entities/session';
import { resolveAgentVisual } from '@/layers/entities/agent';
import { useDefaultAgentSession } from '@/layers/entities/config';
import { orderAgentCards, type DashboardAgentCard } from '../lib/order-agent-cards';

/** What {@link useDashboardAgents} returns. */
export interface DashboardAgents {
  /** All agent cards, ordered (default first, then recency). */
  cards: DashboardAgentCard[];
  /** The default agent's registered path — the click target for its card. */
  defaultAgentDir: string;
}

/**
 * Build the ordered agent-card list for the dashboard from the shared roster,
 * attention model, and recent-activity signals.
 */
export function useDashboardAgents(): DashboardAgents {
  const { data: meshData } = useMeshAgentPaths();
  const { defaultAgentDir } = useDefaultAgentSession();
  const { data: recent } = useRecentSessions();

  const entries = useMemo(() => meshData?.agents ?? [], [meshData]);
  const paths = useMemo(() => entries.map((a) => a.projectPath), [entries]);
  const attentionMap = useAgentAttentionMap(paths);
  const agentActivity = recent?.agentActivity;

  const cards = useMemo(() => {
    const built: DashboardAgentCard[] = entries.map((entry) => {
      const visual = resolveAgentVisual(entry);
      return {
        path: entry.projectPath,
        displayName: getAgentDisplayName(entry),
        color: visual.color,
        emoji: visual.emoji,
        attention: attentionMap[entry.projectPath] ?? 'inactive',
        lastActivityIso: agentActivity?.[entry.projectPath] ?? null,
      };
    });
    return orderAgentCards(built, defaultAgentDir);
  }, [entries, attentionMap, agentActivity, defaultAgentDir]);

  return { cards, defaultAgentDir };
}
