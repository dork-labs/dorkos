import { useMemo } from 'react';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useCommands } from '@/layers/entities/command';
import { useSessions, selectAgentSessions } from '@/layers/entities/session';
import { useSlotContributions } from '@/layers/shared/model';
import { roomDisplayTitle } from '@/layers/entities/room';
import { useAgentFrecency } from './use-agent-frecency';
import { usePaletteRooms, type PaletteRooms } from './use-palette-rooms';
import { usePaletteCommandCenter, type PaletteContinueRow } from './use-palette-command-center';
import { paletteRoomKeywords } from './palette-rooms';
import { PALETTE_NEW_ACTION_IDS } from './palette-contributions';
import { paletteSessionKeywords, type PaletteSessionItem } from './palette-sessions';
import type { PaletteRecentEntry } from './palette-recent';
import type { SearchableItem } from './use-palette-search';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

export interface FeatureItem {
  id: string;
  label: string;
  /** Lucide icon name */
  icon: string;
  shortcut?: string;
  /** Action identifier for the parent to dispatch */
  action: string;
  /** Extra search terms beyond `label` — see `CommandPaletteContribution.keywords`. */
  keywords?: string[];
}

export interface QuickActionItem {
  id: string;
  label: string;
  icon: string;
  action: string;
  /** Extra search terms beyond `label` — see `CommandPaletteContribution.keywords`. */
  keywords?: string[];
}

export interface CommandItemData {
  name: string;
  description?: string;
}

export interface PaletteItems {
  recentAgents: AgentPathEntry[];
  allAgents: AgentPathEntry[];
  features: FeatureItem[];
  commands: CommandItemData[];
  quickActions: QuickActionItem[];
  /**
   * The cockpit's own creation actions, for the zero-query "New" group. A
   * subset of {@link PaletteItems.quickActions}, in {@link PALETTE_NEW_ACTION_IDS}'
   * order.
   */
  newActions: QuickActionItem[];
  /** Channels, direct messages and what is unread among them (spec `rooms` §13.2). */
  rooms: PaletteRooms;
  /** Every conversation in the search window — the corpus, automated runs included. */
  sessions: PaletteSessionItem[];
  /** Live conversations, for the zero-query Continue group. */
  continueRows: PaletteContinueRow[];
  /** The last things this person was in, for the zero-query Recent group. */
  recent: PaletteRecentEntry[];
  /** Flat list of all palette items for Fuse.js search */
  searchableItems: SearchableItem[];
  isLoading: boolean;
}

const MAX_RECENT_AGENTS = 5;

/**
 * Assemble all content groups for the command palette.
 *
 * Combines mesh agent paths, conversations, rooms, slash commands, and
 * registry-sourced feature/action contributions into a single object consumed
 * by CommandPaletteDialog.
 *
 * @param activeCwd - Current working directory to identify the active agent and pin it first
 */
export function usePaletteItems(activeCwd: string | null): PaletteItems {
  const { data: agentPathsData, isLoading: agentsLoading } = useMeshAgentPaths();
  const rooms = usePaletteRooms();
  const { getSortedAgentIds } = useAgentFrecency();
  const { sessions: cwdSessions } = useSessions();

  /**
   * The conversation the active directory is on — newest first, by the
   * canonical membership rule (DOR-203). The slash commands below are that
   * RUNTIME's, so the palette has to name it.
   */
  const activeSession = useMemo(() => {
    if (!cwdSessions || !activeCwd) return null;
    return selectAgentSessions(cwdSessions, activeCwd)[0] ?? null;
  }, [cwdSessions, activeCwd]);

  // Which runtime's commands, said out loud. Asking with no context at all left
  // the server to cold-discover the DEFAULT runtime, so a Codex conversation on
  // screen was offered claude-code's list (DOR-1051). Same three arguments the
  // chat composer's own slash palette passes, for the same reason.
  const { data: commandsData } = useCommands(activeCwd, activeSession?.id, activeSession?.runtime);

  const allPaletteItems = useSlotContributions('command-palette.items');

  const features = useMemo(
    () => allPaletteItems.filter((item) => item.category === 'feature'),
    [allPaletteItems]
  );

  const quickActions = useMemo(
    () => allPaletteItems.filter((item) => item.category === 'quick-action'),
    [allPaletteItems]
  );

  const newActions = useMemo(
    () =>
      PALETTE_NEW_ACTION_IDS.flatMap((id) => {
        const action = quickActions.find((item) => item.id === id);
        return action ? [action] : [];
      }),
    [quickActions]
  );

  const allAgents = useMemo(() => agentPathsData?.agents ?? [], [agentPathsData]);

  const unreadRoomIds = useMemo(() => new Set(rooms.unread.map((room) => room.id)), [rooms.unread]);

  // One list for the mix, because Recent is about places you have been and a
  // channel and a DM are both places. The `#`/`@` split lives in the search
  // prefixes, which address them differently on purpose.
  const allRooms = useMemo(() => [...rooms.channels, ...rooms.dms], [rooms.channels, rooms.dms]);

  const { sessions, continueRows, recent } = usePaletteCommandCenter(
    allAgents,
    allRooms,
    unreadRoomIds
  );

  const recentAgents = useMemo(() => {
    if (allAgents.length === 0) return [];

    const agentMap = new Map(allAgents.map((a) => [a.id, a]));
    const sortedIds = getSortedAgentIds(allAgents.map((a) => a.id));

    // Pin active agent first
    const activeAgent = activeCwd ? allAgents.find((a) => a.projectPath === activeCwd) : null;

    const recentList: AgentPathEntry[] = [];
    if (activeAgent) recentList.push(activeAgent);

    for (const id of sortedIds) {
      if (recentList.length >= MAX_RECENT_AGENTS) break;
      const agent = agentMap.get(id);
      if (agent && agent.id !== activeAgent?.id) {
        recentList.push(agent);
      }
    }

    return recentList;
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

    // Conversations, searched by what they are CALLED. The name is the title
    // and nothing else — an agent's name and a directory ride in the keywords,
    // and a message body rides nowhere: ⌘K finds things, not words (§15).
    for (const session of sessions) {
      items.push({
        id: session.id,
        name: session.title,
        type: 'session',
        keywords: paletteSessionKeywords(session),
        data: session,
      });
    }

    for (const f of features) {
      items.push({ id: f.id, name: f.label, type: 'feature', keywords: f.keywords, data: f });
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

    for (const qa of quickActions) {
      items.push({
        id: qa.id,
        name: qa.label,
        type: 'quick-action',
        keywords: qa.keywords,
        data: qa,
      });
    }

    // Rooms enter the flat list as two types, because the two prefixes address
    // them differently — `#` a channel by its name, `@` a DM by who is in it.
    for (const room of rooms.channels) {
      items.push({
        id: room.id,
        name: roomDisplayTitle(room),
        type: 'room',
        keywords: paletteRoomKeywords(room),
        data: room,
      });
    }

    for (const room of rooms.dms) {
      items.push({
        id: room.id,
        name: room.title,
        type: 'dm',
        keywords: paletteRoomKeywords(room),
        data: room,
      });
    }

    return items;
  }, [allAgents, sessions, commands, features, quickActions, rooms.channels, rooms.dms]);

  return {
    recentAgents,
    allAgents,
    features,
    commands,
    quickActions,
    newActions,
    rooms,
    sessions,
    continueRows,
    recent,
    searchableItems,
    isLoading: agentsLoading,
  };
}
