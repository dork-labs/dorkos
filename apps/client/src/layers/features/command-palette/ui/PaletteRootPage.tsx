import { motion, LayoutGroup } from 'motion/react';
import { CommandGroup, CommandItem, CommandSeparator } from '@/layers/shared/ui';
import { getAgentDisplayName } from '@/layers/shared/lib';
import type { RoomSummary } from '@/layers/entities/room';
import { AgentCommandItem } from './AgentCommandItem';
import { PaletteCommandCenter } from './PaletteCommandCenter';
import { RoomCommandItem } from './RoomCommandItem';
import { SessionCommandItem } from './SessionCommandItem';
import { PalettePrefixLegend } from './PalettePrefixLegend';
import { ICON_MAP, EASE_OUT, listVariants, itemVariants } from './palette-constants';
import type { PaletteRooms } from '../model/use-palette-rooms';
import type { PaletteRecentEntry } from '../model/palette-recent';
import type { PaletteSessionItem } from '../model/palette-sessions';
import type { PaletteContinueRow } from '../model/use-palette-command-center';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { FuseResultMatch } from 'fuse.js';
import type { FeatureItem, QuickActionItem, CommandItemData } from '../model/use-palette-items';

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
  /** Live conversations, for the zero-query Continue group. */
  continueRows: PaletteContinueRow[];
  /** The last things this person was in, for the zero-query Recent group. */
  recent: PaletteRecentEntry[];
  /** The cockpit's own creation actions, for the zero-query New group. */
  newActions: QuickActionItem[];
  searchAgents: AgentPathEntry[];
  /** Conversations matching the current query. */
  searchSessions: PaletteSessionItem[];
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
  onQuickAction: (action: string) => void;
  onGoToAgentActions: (agent: AgentPathEntry) => void;
  onRoomSelect: (room: RoomSummary) => void;
  /** Open a conversation. */
  onSessionSelect: (session: PaletteSessionItem) => void;
  /** Put a slash command in the active conversation's composer and go there. */
  onCommandSelect: (command: string) => void;
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
  continueRows,
  recent,
  newActions,
  searchAgents,
  searchSessions,
  searchFeatures,
  searchCommands,
  searchQuickActions,
  rooms,
  searchChannels,
  searchDms,
  agentMatchMap,
  onFeatureAction,
  onQuickAction,
  onGoToAgentActions,
  onRoomSelect,
  onSessionSelect,
  onCommandSelect,
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
       * Nothing typed: the command center, in its own order (§15). Everything
       * that used to fill this space — Unread, Suggestions, Recent Agents,
       * Features, Quick Actions — is either inside it now or one keystroke away.
       */}
      {isZeroQuery && (
        <PaletteCommandCenter
          continueRows={continueRows}
          recent={recent}
          newActions={newActions}
          selectedCwd={selectedCwd}
          selectedValue={selectedValue}
          onSessionSelect={onSessionSelect}
          onRoomSelect={onRoomSelect}
          onGoToAgentActions={onGoToAgentActions}
          onQuickAction={onQuickAction}
        />
      )}

      {/*
       * Conversations lead the typed list. Recall is what ⌘K is for, and a
       * conversation is the thing people go looking for most and could not find
       * at all until this shipped. (Task 3.2 replaces this fixed order with one
       * blended ranking — until then, first is the honest place for it.)
       */}
      {!isZeroQuery && searchSessions.length > 0 && (
        <CommandGroup heading="Conversations">
          {searchSessions.map((session, index) => (
            <motion.div key={session.id} variants={index < 8 ? itemVariants : undefined}>
              <SessionCommandItem
                item={session}
                isSelected={selectedValue === session.id}
                onSelect={() => onSessionSelect(session)}
              />
            </motion.div>
          ))}
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

      {/* Features — hidden in @ and > mode; shown when searching */}
      {!isZeroQuery && !isAtMode && !isCommandMode && searchFeatures.length > 0 && (
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

      {/* Quick Actions — hidden in @ and > mode; shown when searching */}
      {!isZeroQuery && !isAtMode && !isCommandMode && searchQuickActions.length > 0 && (
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
