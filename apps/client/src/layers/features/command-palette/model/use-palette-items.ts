import { useMemo } from 'react';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useCommands } from '@/layers/entities/command';
import { useSessions, selectAgentSessions } from '@/layers/entities/session';
import { useSlotContributions } from '@/layers/shared/model';
import { hasUnread, roomDisplayTitle, type RoomSummary } from '@/layers/entities/room';
import { interactionKey } from '@/layers/entities/interactions';
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
  /**
   * The cockpit's own creation actions, for the zero-query "New" group. A
   * subset of the registered quick actions, in {@link PALETTE_NEW_ACTION_IDS}'
   * order.
   *
   * The only list of actions this hook hands out. Features, quick actions and
   * slash commands used to come back as three lists of their own, for a palette
   * that drew three groups from them; a typed query is one ranked list now, so
   * they reach the screen through {@link PaletteItems.searchableItems} and
   * nowhere else.
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
 * The ranking fields of a row nothing keeps a history for.
 *
 * Actions and slash commands are not places you have been: nothing records
 * opening one, they have no last activity, nothing waits inside them and none
 * of them is archived. So they rank on relevance alone.
 *
 * **Say the cost out loud: this is a structural handicap, not a neutral
 * default.** Every boost is multiplicative on top of relevance, so a row with no
 * history can never score above `relevance / 2` while a hot unread room reaches
 * `relevance × 1` — an action whose name you typed in full can lose to a room
 * that only nearly matched. That is a deliberate trade and it is defensible for
 * a **recall** front door: the room is where work is actually happening, and
 * §15's whole premise is that ⌘K is for finding your way back to things, not for
 * launching. It is worth revisiting the day the palette becomes somebody's main
 * way of running actions.
 *
 * The cheap escape, if it ever needs one, is to start recording action opens
 * under the same key space — task 3.3 owns that store and could add a fourth
 * {@link InteractionKind} without any change here beyond a `usageKey`.
 */
const UNTRACKED = {
  usageKey: null,
  lastActivityAt: null,
  waiting: false,
  demoted: false,
} as const;

/**
 * What ranking needs to know about a room.
 *
 * Both facts come from the room itself rather than from the palette's own
 * lists, so a channel and a direct message answer them the same way. `hasUnread`
 * decides `waiting` rather than `unreadCount`, because `null` means "you are not
 * in this room" and is not zero — see its own doc.
 *
 * @param room - The room being turned into a searchable row.
 */
function roomRanking(room: RoomSummary) {
  return {
    usageKey: interactionKey('room', room.id),
    lastActivityAt: room.lastActivityAt,
    waiting: hasUnread(room),
    demoted: room.archived,
  };
}

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

  const { sessions, continueRows, recent, agentActivity } = usePaletteCommandCenter(
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
        // Keyed by the DIRECTORY, not the mesh id: that is what the interaction
        // store records when a person opens an agent anywhere in the cockpit,
        // and a key nothing writes ranks every agent as never used.
        usageKey: interactionKey('agent', agent.projectPath),
        lastActivityAt: agentActivity[agent.projectPath] ?? null,
        waiting: false,
        demoted: false,
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
        usageKey: interactionKey('session', session.id),
        lastActivityAt: session.lastActivityAt,
        waiting: false,
        demoted: false,
        data: session,
      });
    }

    for (const f of features) {
      items.push({
        id: f.id,
        name: f.label,
        type: 'feature',
        keywords: f.keywords,
        ...UNTRACKED,
        data: f,
      });
    }

    for (const cmd of commands) {
      items.push({
        id: `cmd-${cmd.name}`,
        name: cmd.name,
        type: 'command',
        keywords: cmd.description ? [cmd.description] : undefined,
        ...UNTRACKED,
        data: cmd,
      });
    }

    for (const qa of quickActions) {
      items.push({
        id: qa.id,
        name: qa.label,
        type: 'quick-action',
        keywords: qa.keywords,
        ...UNTRACKED,
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
        ...roomRanking(room),
        data: room,
      });
    }

    for (const room of rooms.dms) {
      items.push({
        id: room.id,
        name: room.title,
        type: 'dm',
        keywords: paletteRoomKeywords(room),
        ...roomRanking(room),
        data: room,
      });
    }

    return items;
  }, [
    allAgents,
    agentActivity,
    sessions,
    commands,
    features,
    quickActions,
    rooms.channels,
    rooms.dms,
  ]);

  return {
    recentAgents,
    allAgents,
    newActions,
    rooms,
    sessions,
    continueRows,
    recent,
    searchableItems,
    isLoading: agentsLoading,
  };
}
