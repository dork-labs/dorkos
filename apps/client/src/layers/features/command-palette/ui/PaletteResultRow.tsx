/**
 * One row of the ranked result list, whatever kind of thing it stands for
 * (design-decisions §15).
 *
 * The ranked list mixes types, so the switch that used to be six separate group
 * blocks in `PaletteRootPage` lives here instead — one place that knows how each
 * kind of row draws itself, and a `PaletteRootPage` that only knows about order.
 *
 * @module features/command-palette/ui/PaletteResultRow
 */
import { motion } from 'motion/react';
import { CommandItem } from '@/layers/shared/ui';
import { getAgentDisplayName } from '@/layers/shared/lib';
import type { RoomSummary } from '@/layers/entities/room';
import { AgentCommandItem } from './AgentCommandItem';
import { RoomCommandItem } from './RoomCommandItem';
import { SessionCommandItem } from './SessionCommandItem';
import { ICON_MAP, EASE_OUT } from './palette-constants';
import type { RankedRow } from '../model/palette-ranking';
import type { SearchResult } from '../model/use-palette-search';
import type { PaletteSessionItem } from '../model/palette-sessions';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

/** What {@link PaletteResultRow} needs to draw and act on one ranked row. */
export interface PaletteResultRowProps {
  /** The ranked row, with the Fuse matches that produced it. */
  row: RankedRow<SearchResult>;
  /** The directory on screen, so an agent row can mark itself as the active one. */
  selectedCwd: string | null;
  /** cmdk's highlighted value, so a row can show its shortcut hints. */
  selectedValue: string;
  /** Run a feature action. */
  onFeatureAction: (action: string) => void;
  /** Run a quick action. */
  onQuickAction: (action: string) => void;
  /** Drill into an agent's action sub-menu. */
  onGoToAgentActions: (agent: AgentPathEntry) => void;
  /** Open a room. */
  onRoomSelect: (room: RoomSummary) => void;
  /** Open a conversation. */
  onSessionSelect: (session: PaletteSessionItem) => void;
  /** Put a slash command in the active conversation's composer and go there. */
  onCommandSelect: (command: string) => void;
}

/**
 * Draw one ranked row as whatever it is.
 *
 * Every branch renders the row component that kind already had, unchanged: this
 * file moved the choice, it did not invent a seventh way to draw a palette row.
 */
export function PaletteResultRow({
  row,
  selectedCwd,
  selectedValue,
  onFeatureAction,
  onQuickAction,
  onGoToAgentActions,
  onRoomSelect,
  onSessionSelect,
  onCommandSelect,
}: PaletteResultRowProps) {
  const { item, matches } = row.item;

  switch (item.type) {
    case 'session':
      return (
        <SessionCommandItem
          item={item.data}
          isSelected={selectedValue === item.data.id}
          onSelect={() => onSessionSelect(item.data)}
        />
      );

    case 'agent':
      return (
        <AgentCommandItem
          agent={item.data}
          isActive={item.data.projectPath === selectedCwd}
          isSelected={selectedValue === getAgentDisplayName(item.data)}
          onSelect={() => onGoToAgentActions(item.data)}
          nameIndices={
            matches?.find((m) => m.key === 'name')?.indices as
              readonly [number, number][] | undefined
          }
        />
      );

    case 'room':
    case 'dm':
      return <RoomCommandItem room={item.data} onSelect={() => onRoomSelect(item.data)} />;

    case 'command':
      return (
        <CommandItem value={item.data.name} onSelect={() => onCommandSelect(item.data.name)}>
          <motion.div
            whileHover={{ x: 2 }}
            transition={{ duration: 0.1, ease: EASE_OUT }}
            className="flex w-full items-center gap-2"
          >
            <span className="font-mono text-xs">{item.data.name}</span>
            {item.data.description && (
              <span className="text-muted-foreground ml-2 text-xs">{item.data.description}</span>
            )}
          </motion.div>
        </CommandItem>
      );

    case 'feature': {
      const Icon = ICON_MAP[item.data.icon];
      return (
        <CommandItem value={item.data.label} onSelect={() => onFeatureAction(item.data.action)}>
          <motion.div
            whileHover={{ x: 2 }}
            transition={{ duration: 0.1, ease: EASE_OUT }}
            className="flex w-full items-center gap-2"
          >
            {Icon && <Icon className="size-4" />}
            <span>{item.data.label}</span>
            {item.data.shortcut && (
              <span className="text-muted-foreground ml-auto text-xs">{item.data.shortcut}</span>
            )}
          </motion.div>
        </CommandItem>
      );
    }

    case 'quick-action': {
      const Icon = ICON_MAP[item.data.icon];
      return (
        <CommandItem value={item.data.label} onSelect={() => onQuickAction(item.data.action)}>
          <motion.div
            whileHover={{ x: 2 }}
            transition={{ duration: 0.1, ease: EASE_OUT }}
            className="flex w-full items-center gap-2"
          >
            {Icon && <Icon className="size-4" />}
            <span>{item.data.label}</span>
          </motion.div>
        </CommandItem>
      );
    }
  }
}
