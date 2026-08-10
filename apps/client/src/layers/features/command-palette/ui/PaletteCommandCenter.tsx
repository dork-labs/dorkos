/**
 * The palette before anything is typed — a command center, not a menu
 * (design-decisions §15).
 *
 * @module features/command-palette/ui/PaletteCommandCenter
 */
import { motion } from 'motion/react';
import { CommandGroup, CommandItem, CommandSeparator } from '@/layers/shared/ui';
import { getAgentDisplayName } from '@/layers/shared/lib';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { AgentCommandItem } from './AgentCommandItem';
import { RoomCommandItem } from './RoomCommandItem';
import { SessionCommandItem } from './SessionCommandItem';
import { EASE_OUT, ICON_MAP, itemVariants } from './palette-constants';
import type { PaletteContinueRow } from '../model/use-palette-command-center';
import type { PaletteRecentEntry } from '../model/palette-recent';
import type { PaletteSessionItem } from '../model/palette-sessions';
import type { QuickActionItem } from '../model/use-palette-items';

/** How many rows keep their stagger entrance before it stops being worth it. */
const STAGGERED_ROWS = 8;

/** Props for {@link PaletteCommandCenter}. */
export interface PaletteCommandCenterProps {
  /** Live conversations, waiting-on-you first. */
  continueRows: PaletteContinueRow[];
  /** The last things this person was in, across types. */
  recent: PaletteRecentEntry[];
  /** The cockpit's own "make something" actions. */
  newActions: QuickActionItem[];
  /** The directory on screen, so its agent row reads as current. */
  selectedCwd: string | null;
  /** cmdk's highlighted value — what `↵` would act on. */
  selectedValue: string;
  /** Open a conversation. */
  onSessionSelect: (session: PaletteSessionItem) => void;
  /** Open a room. */
  onRoomSelect: (room: RoomSummary) => void;
  /** Drill into an agent's actions. */
  onGoToAgentActions: (agent: AgentPathEntry) => void;
  /** Run one of the New actions. */
  onQuickAction: (action: string) => void;
}

/**
 * Continue → Recent → New, and nothing else.
 *
 * The order is the argument. **Continue** is what is happening right now, so
 * `⌘K ↵` puts you back in the conversation your agent is working in. **Recent**
 * is where you were, which is where an overnight-archived row resurfaces and
 * how a person actually recalls a conversation — by name and by when, not by
 * what was said in it. **New** is the one place anything gets created. The
 * prefix legend closes the list, drawn by the page above this one.
 *
 * Every group is absent when it is empty, Continue included: an empty box is
 * never rendered (BC-1), and a "Continue" heading over nothing would be the
 * palette claiming work that is not happening.
 *
 * What is deliberately gone: the Suggestions group (its "Continue: …" row is
 * this whole section now, and its other two guesses are outranked by facts),
 * the separate Unread group (an unread room leads Recent instead of owning a
 * band of its own), and the Features and Quick Actions dumps (both are still
 * one keystroke away — typing searches them).
 */
export function PaletteCommandCenter({
  continueRows,
  recent,
  newActions,
  selectedCwd,
  selectedValue,
  onSessionSelect,
  onRoomSelect,
  onGoToAgentActions,
  onQuickAction,
}: PaletteCommandCenterProps) {
  return (
    <>
      {continueRows.length > 0 && (
        <CommandGroup heading="Continue">
          {continueRows.map((row, index) => (
            <motion.div
              key={row.session.id}
              variants={index < STAGGERED_ROWS ? itemVariants : undefined}
            >
              <SessionCommandItem
                item={row.session}
                live={{ verb: row.verb, signal: row.signal }}
                isSelected={selectedValue === row.session.id}
                onSelect={() => onSessionSelect(row.session)}
              />
            </motion.div>
          ))}
        </CommandGroup>
      )}

      {recent.length > 0 && (
        <CommandGroup heading="Recent">
          {recent.map((entry, index) => (
            <motion.div
              key={entry.key}
              variants={index < STAGGERED_ROWS ? itemVariants : undefined}
            >
              {entry.kind === 'session' && (
                <SessionCommandItem
                  item={entry.session}
                  isSelected={selectedValue === entry.session.id}
                  onSelect={() => onSessionSelect(entry.session)}
                />
              )}
              {entry.kind === 'room' && (
                <RoomCommandItem room={entry.room} onSelect={() => onRoomSelect(entry.room)} />
              )}
              {entry.kind === 'agent' && (
                <AgentCommandItem
                  agent={entry.agent}
                  isActive={entry.agent.projectPath === selectedCwd}
                  isSelected={selectedValue === getAgentDisplayName(entry.agent)}
                  onSelect={() => onGoToAgentActions(entry.agent)}
                />
              )}
            </motion.div>
          ))}
        </CommandGroup>
      )}

      {newActions.length > 0 && (
        <>
          {/* Only when there is something above to be separated FROM — on a
              first run there is not, and a rule across the top of an empty
              palette separates nothing. */}
          {(continueRows.length > 0 || recent.length > 0) && <CommandSeparator />}
          <CommandGroup heading="New">
            {newActions.map((action, index) => {
              const Icon = ICON_MAP[action.icon];
              return (
                <motion.div
                  key={action.id}
                  variants={index < STAGGERED_ROWS ? itemVariants : undefined}
                >
                  <CommandItem value={action.label} onSelect={() => onQuickAction(action.action)}>
                    <motion.div
                      whileHover={{ x: 2 }}
                      transition={{ duration: 0.1, ease: EASE_OUT }}
                      className="flex w-full items-center gap-2"
                    >
                      {Icon && <Icon className="size-4" />}
                      <span>{action.label}</span>
                    </motion.div>
                  </CommandItem>
                </motion.div>
              );
            })}
          </CommandGroup>
        </>
      )}
    </>
  );
}
