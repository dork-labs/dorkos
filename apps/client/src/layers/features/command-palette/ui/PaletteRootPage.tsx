import { motion } from 'motion/react';
import { CommandGroup, CommandItem, CommandSeparator } from '@/layers/shared/ui';
import type { RoomSummary } from '@/layers/entities/room';
import { PaletteCommandCenter } from './PaletteCommandCenter';
import { PaletteResultRow } from './PaletteResultRow';
import { PalettePrefixLegend } from './PalettePrefixLegend';
import {
  BEST_MATCH_HEADING,
  RESULT_GROUP_LABEL,
  listVariants,
  itemVariants,
} from './palette-constants';
import { groupRankedRows, type RankedRow } from '../model/palette-ranking';
import type { PaletteRooms } from '../model/use-palette-rooms';
import type { PaletteRecentEntry } from '../model/palette-recent';
import type { PaletteSessionItem } from '../model/palette-sessions';
import type { PaletteContinueRow } from '../model/use-palette-command-center';
import type { SearchResult } from '../model/use-palette-search';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { QuickActionItem } from '../model/use-palette-items';

/** How many rows into the list the stagger entrance keeps animating. */
const STAGGERED_ROWS = 8;

interface PaletteRootPageProps {
  staggerKey: number;
  isZeroQuery: boolean;
  /** Whether the `#` prefix is active, scoping the palette to channels. */
  isRoomMode: boolean;
  selectedCwd: string | null;
  selectedValue: string;
  /** Live conversations, for the zero-query Continue group. */
  continueRows: PaletteContinueRow[];
  /** The last things this person was in, for the zero-query Recent group. */
  recent: PaletteRecentEntry[];
  /** The cockpit's own creation actions, for the zero-query New group. */
  newActions: QuickActionItem[];
  /** The row that stands clear of the rest, or `null` when none has earned it. */
  bestMatch: RankedRow<SearchResult> | null;
  /** Everything the query matched, in one ranked order across types. */
  rows: RankedRow<SearchResult>[];
  /** The whole room list, for its load state. */
  rooms: PaletteRooms;
  onFeatureAction: (action: string) => void;
  onQuickAction: (action: string) => void;
  onGoToAgentActions: (agent: AgentPathEntry) => void;
  onRoomSelect: (room: RoomSummary) => void;
  /** Open a conversation. */
  onSessionSelect: (session: PaletteSessionItem) => void;
  /** Put a slash command in the active conversation's composer and go there. */
  onCommandSelect: (command: string) => void;
}

/**
 * Root page content for the command palette.
 *
 * Two states, and they are different surfaces rather than two densities of the
 * same one. **Nothing typed** is the command center: Continue, Recent, New, the
 * prefix legend. **Something typed** is one ranked list across every kind of
 * thing ⌘K can find — relevance blended with frecency and recency
 * (`palette-ranking`), with the standout row lifted into its own **Best match**
 * section when there is one.
 *
 * The headings on the ranked list name what a row IS; they do not decide where
 * it sits. That is the whole change: before this, a group order fixed in this
 * file drew a perfect room match below a weak agent match, every time, and
 * nothing a person typed could move it (design-decisions §15).
 */
export function PaletteRootPage({
  staggerKey,
  isZeroQuery,
  isRoomMode,
  selectedCwd,
  selectedValue,
  continueRows,
  recent,
  newActions,
  bestMatch,
  rows,
  rooms,
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

  const groups = groupRankedRows(rows, (row) => RESULT_GROUP_LABEL[row.item.item.type]);

  // The stagger runs down the WHOLE list rather than restarting inside each
  // heading, because the list is one list — rows arriving in two overlapping
  // waves would read as two, which is the shape this page just stopped being.
  // A set of keys rather than a counter mutated inside the map below, so this
  // component stays a pure function of its props.
  const staggered = new Set(
    rows.slice(0, bestMatch ? STAGGERED_ROWS - 1 : STAGGERED_ROWS).map((row) => row.key)
  );

  const rowProps = {
    selectedCwd,
    selectedValue,
    onFeatureAction,
    onQuickAction,
    onGoToAgentActions,
    onRoomSelect,
    onSessionSelect,
    onCommandSelect,
  };

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
       * The one row the ranking is confident about, said out loud. Four things
       * withhold it — no term typed, a single result, an archived leader, or a
       * lead under `BEST_MATCH_MARGIN` — and when it is withheld the list below
       * is exactly the list that would have been drawn anyway, with this row
       * back on top of it. (How often that happens depends entirely on the
       * corpus and the query, so this comment does not guess.)
       */}
      {!isZeroQuery && bestMatch && (
        <CommandGroup heading={BEST_MATCH_HEADING}>
          <motion.div variants={itemVariants}>
            <PaletteResultRow row={bestMatch} {...rowProps} />
          </motion.div>
        </CommandGroup>
      )}

      {!isZeroQuery &&
        groups.map((group, groupIndex) => (
          // The label alone is not a key: a kind can head more than one run when
          // the ranking interleaves types, which is the point of the run.
          <CommandGroup key={`${group.label}-${groupIndex}`} heading={group.label}>
            {group.rows.map((row) => (
              <motion.div
                key={row.key}
                variants={staggered.has(row.key) ? itemVariants : undefined}
              >
                <PaletteResultRow row={row} {...rowProps} />
              </motion.div>
            ))}
          </CommandGroup>
        ))}

      {/*
       * Why the channel list has a status row and no other kind does: `#` is a
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
