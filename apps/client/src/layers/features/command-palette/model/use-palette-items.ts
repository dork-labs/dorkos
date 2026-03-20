import { useMemo } from 'react';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useCommands } from '@/layers/entities/command';
import { useSessions } from '@/layers/entities/session';
import { useActiveRunCount } from '@/layers/entities/pulse';
import { useAppStore } from '@/layers/shared/model';
import { shortenHomePath } from '@/layers/shared/lib';
import { useAgentFrecency } from './use-agent-frecency';
import type { SearchableItem } from './use-palette-search';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

interface FeatureItem {
  id: string;
  label: string;
  /** Lucide icon name */
  icon: string;
  shortcut?: string;
  /** Action identifier for the parent to dispatch */
  action: string;
}

interface QuickActionItem {
  id: string;
  label: string;
  icon: string;
  action: string;
}

interface CommandItemData {
  name: string;
  description?: string;
}

export interface SuggestionItem {
  id: string;
  label: string;
  description: string;
  icon: string;
  action: string;
}

export interface PaletteItems {
  recentAgents: AgentPathEntry[];
  allAgents: AgentPathEntry[];
  features: FeatureItem[];
  commands: CommandItemData[];
  quickActions: QuickActionItem[];
  /** Flat list of all palette items for Fuse.js search */
  searchableItems: SearchableItem[];
  /** Contextual suggestions for the zero-query state (max 3) */
  suggestions: SuggestionItem[];
  isLoading: boolean;
}

const FEATURES: FeatureItem[] = [
  { id: 'pulse', label: 'Pulse Scheduler', icon: 'Clock', action: 'openPulse' },
  { id: 'relay', label: 'Relay Messaging', icon: 'Radio', action: 'openRelay' },
  { id: 'mesh', label: 'Mesh Network', icon: 'Globe', action: 'openMesh' },
  { id: 'settings', label: 'Settings', icon: 'Settings', action: 'openSettings' },
];

const QUICK_ACTIONS: QuickActionItem[] = [
  { id: 'dashboard', label: 'Go to Dashboard', icon: 'Home', action: 'navigateDashboard' },
  { id: 'new-session', label: 'New Session', icon: 'Plus', action: 'newSession' },
  { id: 'discover', label: 'Discover Agents', icon: 'Search', action: 'discoverAgents' },
  { id: 'browse', label: 'Browse Filesystem', icon: 'FolderOpen', action: 'browseFilesystem' },
  { id: 'theme', label: 'Toggle Theme', icon: 'Moon', action: 'toggleTheme' },
];

const MAX_RECENT_AGENTS = 5;
const MAX_SUGGESTIONS = 3;
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Assemble all content groups for the command palette.
 *
 * Combines mesh agent paths, slash commands, and static feature/action lists
 * into a single object consumed by CommandPaletteDialog.
 *
 * @param activeCwd - Current working directory to identify the active agent and pin it first
 */
export function usePaletteItems(activeCwd: string | null): PaletteItems {
  const { data: agentPathsData, isLoading: agentsLoading } = useMeshAgentPaths();
  const { data: commandsData } = useCommands();
  const { getSortedAgentIds } = useAgentFrecency();
  const { sessions } = useSessions();
  const { data: activeRunCount } = useActiveRunCount();
  const previousCwd = useAppStore((s) => s.previousCwd);

  const allAgents = useMemo(() => agentPathsData?.agents ?? [], [agentPathsData]);

  const recentAgents = useMemo(() => {
    if (allAgents.length === 0) return [];

    const agentMap = new Map(allAgents.map((a) => [a.id, a]));
    const sortedIds = getSortedAgentIds(allAgents.map((a) => a.id));

    // Pin active agent first
    const activeAgent = activeCwd ? allAgents.find((a) => a.projectPath === activeCwd) : null;

    const recent: AgentPathEntry[] = [];
    if (activeAgent) recent.push(activeAgent);

    for (const id of sortedIds) {
      if (recent.length >= MAX_RECENT_AGENTS) break;
      const agent = agentMap.get(id);
      if (agent && agent.id !== activeAgent?.id) {
        recent.push(agent);
      }
    }

    return recent;
  }, [allAgents, getSortedAgentIds, activeCwd]);

  const commands: CommandItemData[] = useMemo(() => {
    if (!commandsData) return [];
    return commandsData.commands.map((cmd) => ({
      name: cmd.fullCommand,
      description: cmd.description,
    }));
  }, [commandsData]);

  const searchableItems: SearchableItem[] = useMemo(() => {
    const items: SearchableItem[] = [];

    for (const agent of allAgents) {
      items.push({
        id: agent.id,
        name: agent.name,
        type: 'agent',
        keywords: [agent.projectPath, agent.id],
        data: agent,
      });
    }

    for (const f of FEATURES) {
      items.push({ id: f.id, name: f.label, type: 'feature', data: f });
    }

    for (const cmd of commands) {
      items.push({
        id: `cmd-${cmd.name}`,
        name: cmd.name,
        type: 'command',
        keywords: cmd.description ? [cmd.description] : undefined,
        data: cmd,
      });
    }

    for (const qa of QUICK_ACTIONS) {
      items.push({ id: qa.id, name: qa.label, type: 'quick-action', data: qa });
    }

    return items;
  }, [allAgents, commands]);

  const suggestions = useMemo(() => {
    const items: SuggestionItem[] = [];

    // Rule 1: 'Continue session' if most recent session in current CWD was active < 1h ago
    if (sessions && activeCwd) {
      const cwdSessions = sessions.filter((s) => s.cwd === activeCwd);
      if (cwdSessions.length > 0) {
        const mostRecent = cwdSessions[0];
        const lastActive = new Date(mostRecent.updatedAt ?? mostRecent.createdAt ?? '').getTime();
        if (lastActive > Date.now() - ONE_HOUR_MS) {
          // eslint-disable-line react-hooks/purity -- Date.now() re-evaluates when sessions change
          items.push({
            id: 'suggestion-continue',
            label: `Continue: ${mostRecent.title ?? 'Last session'}`,
            description: 'Resume your most recent session',
            icon: 'Clock',
            action: `continueSession:${mostRecent.id}`,
          });
        }
      }
    }

    // Rule 2: 'N active Pulse runs' if activeRunCount > 0
    if (activeRunCount && activeRunCount > 0) {
      items.push({
        id: 'suggestion-pulse',
        label: `${activeRunCount} active Pulse run${activeRunCount > 1 ? 's' : ''}`,
        description: 'View running schedules',
        icon: 'Clock',
        action: 'openPulse',
      });
    }

    // Rule 3: 'Switch back to {previousAgent}' if user recently switched
    if (previousCwd && previousCwd !== activeCwd) {
      const prevAgent = allAgents.find((a) => a.projectPath === previousCwd);
      if (prevAgent) {
        items.push({
          id: 'suggestion-switchback',
          label: `Switch back to ${prevAgent.name}`,
          description: shortenHomePath(previousCwd),
          icon: 'FolderOpen',
          action: `switchAgent:${prevAgent.id}`,
        });
      }
    }

    return items.slice(0, MAX_SUGGESTIONS);
  }, [sessions, activeCwd, activeRunCount, previousCwd, allAgents]);

  return {
    recentAgents,
    allAgents,
    features: FEATURES,
    commands,
    quickActions: QUICK_ACTIONS,
    searchableItems,
    suggestions,
    isLoading: agentsLoading,
  };
}
