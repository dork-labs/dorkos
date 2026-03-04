import { useMemo } from 'react';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useCommands } from '@/layers/entities/command';
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

export interface PaletteItems {
  recentAgents: AgentPathEntry[];
  allAgents: AgentPathEntry[];
  features: FeatureItem[];
  commands: CommandItemData[];
  quickActions: QuickActionItem[];
  /** Flat list of all palette items for Fuse.js search */
  searchableItems: SearchableItem[];
  isLoading: boolean;
}

const FEATURES: FeatureItem[] = [
  { id: 'pulse', label: 'Pulse Scheduler', icon: 'Clock', action: 'openPulse' },
  { id: 'relay', label: 'Relay Messaging', icon: 'Radio', action: 'openRelay' },
  { id: 'mesh', label: 'Mesh Network', icon: 'Globe', action: 'openMesh' },
  { id: 'settings', label: 'Settings', icon: 'Settings', action: 'openSettings' },
];

const QUICK_ACTIONS: QuickActionItem[] = [
  { id: 'new-session', label: 'New Session', icon: 'Plus', action: 'newSession' },
  { id: 'discover', label: 'Discover Agents', icon: 'Search', action: 'discoverAgents' },
  { id: 'browse', label: 'Browse Filesystem', icon: 'FolderOpen', action: 'browseFilesystem' },
  { id: 'theme', label: 'Toggle Theme', icon: 'Moon', action: 'toggleTheme' },
];

const MAX_RECENT_AGENTS = 5;

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

  return {
    recentAgents,
    allAgents,
    features: FEATURES,
    commands,
    quickActions: QUICK_ACTIONS,
    searchableItems,
    isLoading: agentsLoading,
  };
}
