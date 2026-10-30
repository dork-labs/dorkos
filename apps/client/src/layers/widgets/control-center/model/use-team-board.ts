import { useMemo } from 'react';
import { useConfig } from '@/layers/entities/config';
import { resolveAgentVisual } from '@/layers/entities/agent';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useSessionListStore } from '@/layers/entities/session';
import { activityVerb } from '@/layers/shared/lib';
import {
  buildTeamRows,
  teamBoardFigures,
  unclaimedChats,
  type TeamBoardAgent,
  type TeamBoardChat,
  type TeamBoardFigure,
  type TeamBoardRow,
} from './team-board';

/** How often the top line's load and disk figures refresh while the view is open. */
const CAPACITY_REFRESH_MS = 15_000;

/** Everything the Team view draws. */
export interface TeamBoard {
  figures: TeamBoardFigure[];
  /** The running count has reached the cap. */
  atCap: boolean;
  rows: TeamBoardRow[];
  /** Live chats in no registered agent's folder. */
  otherChats: TeamBoardChat[];
  isEmpty: boolean;
}

/**
 * The Team view's data, in one place so its source can change without touching
 * the view.
 *
 * Today the chats come from the live session store, which learns a chat's status
 * when it next changes: a chat that started before this window connected shows
 * up on its next change. DOR-3460's server list replaces this read.
 */
export function useTeamBoard(): TeamBoard {
  const { data: agentData } = useMeshAgentPaths();
  const { data: config } = useConfig({ refetchInterval: CAPACITY_REFRESH_MS });

  const sessions = useSessionListStore((s) => s.sessions);
  const statuses = useSessionListStore((s) => s.statuses);
  const statusCwds = useSessionListStore((s) => s.statusCwds);

  const chats = useMemo(() => {
    const live: TeamBoardChat[] = [];
    for (const [id, status] of Object.entries(statuses)) {
      const cwd = statusCwds[id] ?? sessions[id]?.cwd;
      if (cwd === undefined) continue;
      const { lifecycle, activity } = status;
      if (lifecycle !== 'streaming' && lifecycle !== 'blocked') continue;
      live.push({
        id,
        cwd,
        title: sessions[id]?.title || 'Untitled chat',
        activity: activityVerb(lifecycle, activity),
        waiting: lifecycle === 'blocked',
        startedAt: null,
      });
    }
    return live;
  }, [sessions, statuses, statusCwds]);

  const agents = useMemo<TeamBoardAgent[]>(
    () =>
      (agentData?.agents ?? []).map((agent) => ({
        id: agent.id,
        name: agent.displayName ?? agent.name,
        projectPath: agent.projectPath,
        ...resolveAgentVisual(agent),
      })),
    [agentData]
  );

  const capacity = config?.capacity;
  return useMemo(() => {
    const maxAgentChats = capacity?.maxAgentChats ?? null;
    return {
      figures: teamBoardFigures(chats.length, {
        maxAgentChats,
        loadAverage: capacity?.loadAverage ?? null,
        freeDiskBytes: capacity?.freeDiskBytes ?? null,
      }),
      atCap: maxAgentChats !== null && chats.length >= maxAgentChats,
      rows: buildTeamRows(agents, chats),
      otherChats: unclaimedChats(agents, chats),
      isEmpty: chats.length === 0,
    };
  }, [agents, chats, capacity]);
}
