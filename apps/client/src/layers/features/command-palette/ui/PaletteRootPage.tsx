import { motion, LayoutGroup } from 'motion/react';
import { CommandGroup, CommandItem, CommandSeparator } from '@/layers/shared/ui';
import { getAgentDisplayName } from '@/layers/shared/lib';
import type { RoomSummary } from '@/layers/entities/room';
import { AgentCommandItem } from './AgentCommandItem';
import { RoomCommandItem } from './RoomCommandItem';
import { PalettePrefixLegend } from './PalettePrefixLegend';
import { ICON_MAP, EASE_OUT, listVariants, itemVariants } from './palette-constants';
import type { PaletteRooms } from '../model/use-palette-rooms';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { FuseResultMatch } from 'fuse.js';
import type {
  SuggestionItem,
  FeatureItem,
  QuickActionItem,
  CommandItemData,
} from '../model/use-palette-items';

interface PaletteRootPageProps {
  staggerKey: number;
  isZeroQuery: boolean;
  isAtMode: boolean;
  isCommandMode: boolean;
  /** Whether the `#` prefix is active, scoping the palette to channels. */
  isRoomMode: boolean;
  search: string;
  selectedCwd: string | null;
  selectedValue: string;
  suggestions: SuggestionItem[];
  recentAgents: AgentPathEntry[];
  allAgents: AgentPathEntry[];
  searchAgents: AgentPathEntry[];
  searchFeatures: FeatureItem[];
  searchCommands: CommandItemData[];
  searchQuickActions: QuickActionItem[];
  /** The whole room list, for its load state and its unread rows. */
  rooms: PaletteRooms;
  /** Channels matching the current query. */
  searchChannels: RoomSummary[];
  /** Direct messages matching the current query. */
  searchDms: RoomSummary[];
  agentMatchMap: Map<string, readonly FuseResultMatch[] | undefined>;
  onFeatureAction: (action: string) => void;
  onAgentSelect: (agent: AgentPathEntry) => void;
  onQuickAction: (action: string) => void;
  onGoToAgentActions: (agent: AgentPathEntry) => void;
  onRoomSelect: (room: RoomSummary) => void;
  /** Open a conversation the suggestion names. */
  onSessionSelect: (sessionId: string) => void;
  /** Put a slash command in the active conversation's composer and go there. */
  onCommandSelect: (command: string) => void;
  onClose: () => void;
}

/** Root page content for the command palette — renders all groups with stagger animation. */
export function PaletteRootPage({
  staggerKey,
  isZeroQuery,
  isAtMode,
  isCommandMode,
  isRoomMode,
  search,
  selectedCwd,
  selectedValue,
  suggestions,
  recentAgents,
  allAgents,
  searchAgents,
  searchFeatures,
  searchCommands,
  searchQuickActions,
  rooms,
  searchChannels,
  searchDms,
  agentMatchMap,
  onFeatureAction,
  onAgentSelect,
  onQuickAction,
  onGoToAgentActions,
  onRoomSelect,
  onSessionSelect,
  onCommandSelect,
  onClose,
}: PaletteRootPageProps) {
  // What to say instead of a channel list when there is none to show. Only `#`
  // mode asks: everywhere else rooms are one group among several, and a palette
  // that announced "couldn't load channels" while showing agents and commands
  // would be reporting a failure nobody asked about.
  const channelStatus = isRoomMode
    ? rooms.isError
      ? 'Could not load your channels.'
      : rooms.isLoading
        ? 'Loading channels…'
        : rooms.channels.length === 0
          ? 'No channels yet.'
          : null
    : null;

  return (
    <motion.div key={staggerKey} variants={listVariants} initial="hidden" animate="visible">
      {/*
       * Unread rooms, before anything is typed — the first thing in the list, so
       * Cmd+K then Enter goes to whatever needs reading (spec `rooms` §13.2).
       * It sits above Suggestions deliberately: a suggestion is a guess about
       * what you might want, and an unread room is a fact about what is waiting.
       */}
      {isZeroQuery && rooms.unread.length > 0 && (
        <CommandGroup heading="Unread">
          {rooms.unread.map((room, index) => (
            <motion.div key={room.id} variants={index < 8 ? itemVariants : undefined}>
              <RoomCommandItem room={room} onSelect={() => onRoomSelect(room)} />
            </motion.div>
          ))}
        </CommandGroup>
      )}

      {/* Contextual suggestions — shown at top of zero-query state */}
      {isZeroQuery && suggestions.length > 0 && (
        <CommandGroup heading="Suggestions">
          {suggestions.map((s, index) => {
            const Icon = ICON_MAP[s.icon];
            return (
              <motion.div key={s.id} variants={index < 8 ? itemVariants : undefined}>
                <CommandItem
                  value={s.id}
                  onSelect={() => {
                    if (s.action === 'openTasks') {
                      onFeatureAction('openTasks');
                    } else if (s.action.startsWith('switchAgent:')) {
                      const agentId = s.action.split(':')[1];
                      const agent = allAgents.find((a) => a.id === agentId);
                      if (agent) onAgentSelect(agent);
                    } else if (s.action.startsWith('continueSession:')) {
                      // Everything after the first `:` — a session id never
                      // contains one, but splitting on all of them would still
                      // be a rule this row does not need.
                      onSessionSelect(s.action.slice('continueSession:'.length));
                    } else {
                      onClose();
                    }
                  }}
                >
                  <motion.div
                    whileHover={{ x: 2 }}
                    transition={{ duration: 0.1, ease: EASE_OUT }}
                    className="flex w-full items-center gap-2"
                  >
                    {Icon && <Icon className="size-4" />}
                    <div className="min-w-0 flex-1">
                      <span className="text-sm">{s.label}</span>
                      <span className="text-muted-foreground ml-2 text-xs">{s.description}</span>
                    </div>
                  </motion.div>
                </CommandItem>
              </motion.div>
            );
          })}
        </CommandGroup>
      )}

      {/* Zero-query state: Recent Agents group */}
      {isZeroQuery && recentAgents.length > 0 && (
        <CommandGroup heading="Recent Agents">
          <LayoutGroup id="cmd-palette-recent">
            {recentAgents.map((agent, index) => (
              <motion.div key={agent.id} variants={index < 8 ? itemVariants : undefined}>
                <AgentCommandItem
                  agent={agent}
                  isActive={agent.projectPath === selectedCwd}
                  isSelected={selectedValue === getAgentDisplayName(agent)}
                  onSelect={() => onGoToAgentActions(agent)}
                />
              </motion.div>
            ))}
          </LayoutGroup>
        </CommandGroup>
      )}

      {/* Search state: All Agents — always shown in @ mode or when searching */}
      {!isZeroQuery && searchAgents.length > 0 && (
        <CommandGroup heading="All Agents">
          <LayoutGroup id="cmd-palette-all">
            {searchAgents.map((agent, index) => (
              <motion.div key={agent.id} variants={index < 8 ? itemVariants : undefined}>
                <AgentCommandItem
                  agent={agent}
                  isActive={agent.projectPath === selectedCwd}
                  isSelected={selectedValue === getAgentDisplayName(agent)}
                  onSelect={() => onGoToAgentActions(agent)}
                  nameIndices={
                    agentMatchMap.get(agent.id)?.find((m) => m.key === 'name')?.indices as
                      | readonly [number, number][]
                      | undefined
                  }
                />
              </motion.div>
            ))}
          </LayoutGroup>
        </CommandGroup>
      )}

      {/* Channels — what `#` addresses, and what a plain query finds beside everything else */}
      {!isZeroQuery && searchChannels.length > 0 && (
        <>
          <CommandSeparator />
          <CommandGroup heading="Channels">
            {searchChannels.map((room, index) => (
              <motion.div key={room.id} variants={index < 8 ? itemVariants : undefined}>
                <RoomCommandItem room={room} onSelect={() => onRoomSelect(room)} />
              </motion.div>
            ))}
          </CommandGroup>
        </>
      )}

      {/*
       * Why the channel list has a status row and no other group does: `#` is a
       * scope, so when it holds nothing there is nothing else on screen to
       * explain the emptiness. A disabled CommandItem rather than plain markup,
       * so cmdk counts a row and does not also print "No results found."
       */}
      {channelStatus && (
        <CommandGroup heading="Channels">
          <CommandItem disabled value="rooms-status" className="text-muted-foreground text-sm">
            {channelStatus}
          </CommandItem>
        </CommandGroup>
      )}

      {/* Direct messages — under `@` beside the agents, because a DM is addressed by who is in it */}
      {!isZeroQuery && searchDms.length > 0 && (
        <>
          <CommandSeparator />
          <CommandGroup heading="Direct Messages">
            {searchDms.map((room, index) => (
              <motion.div key={room.id} variants={index < 8 ? itemVariants : undefined}>
                <RoomCommandItem room={room} onSelect={() => onRoomSelect(room)} />
              </motion.div>
            ))}
          </CommandGroup>
        </>
      )}

      {/* Features — hidden in @ and > mode; shown in zero-query and non-prefix search */}
      {!isAtMode && !isCommandMode && searchFeatures.length > 0 && (
        <>
          <CommandSeparator />
          <CommandGroup heading="Features">
            {searchFeatures.map((f, index) => {
              const Icon = ICON_MAP[f.icon];
              return (
                <motion.div key={f.id} variants={index < 8 ? itemVariants : undefined}>
                  <CommandItem value={f.label} onSelect={() => onFeatureAction(f.action)}>
                    <motion.div
                      whileHover={{ x: 2 }}
                      transition={{ duration: 0.1, ease: EASE_OUT }}
                      className="flex w-full items-center gap-2"
                    >
                      {Icon && <Icon className="size-4" />}
                      <span>{f.label}</span>
                      {f.shortcut && (
                        <span className="text-muted-foreground ml-auto text-xs">{f.shortcut}</span>
                      )}
                    </motion.div>
                  </CommandItem>
                </motion.div>
              );
            })}
          </CommandGroup>
        </>
      )}

      {/* Commands — hidden in @ mode; shown in > mode or when searching */}
      {!isAtMode && (isCommandMode || search.length > 0) && searchCommands.length > 0 && (
        <>
          <CommandSeparator />
          <CommandGroup heading="Commands">
            {searchCommands.map((cmd, index) => (
              <motion.div key={cmd.name} variants={index < 8 ? itemVariants : undefined}>
                <CommandItem value={cmd.name} onSelect={() => onCommandSelect(cmd.name)}>
                  <motion.div
                    whileHover={{ x: 2 }}
                    transition={{ duration: 0.1, ease: EASE_OUT }}
                    className="flex w-full items-center gap-2"
                  >
                    <span className="font-mono text-xs">{cmd.name}</span>
                    {cmd.description && (
                      <span className="text-muted-foreground ml-2 text-xs">{cmd.description}</span>
                    )}
                  </motion.div>
                </CommandItem>
              </motion.div>
            ))}
          </CommandGroup>
        </>
      )}

      {/* Quick Actions — hidden in @ and > mode; shown in zero-query and non-prefix search */}
      {!isAtMode && !isCommandMode && searchQuickActions.length > 0 && (
        <>
          <CommandSeparator />
          <CommandGroup heading="Quick Actions">
            {searchQuickActions.map((qa, index) => {
              const Icon = ICON_MAP[qa.icon];
              return (
                <motion.div key={qa.id} variants={index < 8 ? itemVariants : undefined}>
                  <CommandItem value={qa.label} onSelect={() => onQuickAction(qa.action)}>
                    <motion.div
                      whileHover={{ x: 2 }}
                      transition={{ duration: 0.1, ease: EASE_OUT }}
                      className="flex w-full items-center gap-2"
                    >
                      {Icon && <Icon className="size-4" />}
                      <span>{qa.label}</span>
                    </motion.div>
                  </CommandItem>
                </motion.div>
              );
            })}
          </CommandGroup>
        </>
      )}

      {/*
       * The prefix legend closes the zero-query list. This is where a person is
       * looking for a way in rather than at a result, and a shortcut nobody is
       * told about is folklore (spec `rooms` §14.5).
       */}
      {isZeroQuery && (
        <>
          <CommandSeparator />
          <PalettePrefixLegend />
        </>
      )}
    </motion.div>
  );
}
