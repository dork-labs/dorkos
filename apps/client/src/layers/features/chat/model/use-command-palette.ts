import { useState, useEffect, useMemo, useCallback } from 'react';
import type { CommandEntry } from '@dorkos/shared/types';
import {
  rankCommand,
  type PaletteCommandEntry,
  type RankedCommandEntry,
} from '@/layers/entities/command';

interface UseCommandPaletteOptions {
  commands: PaletteCommandEntry[];
  input: string;
  cursorPos: number;
}

/**
 * The first selectable (non-disabled) index at or after `start`, scanning in
 * `direction` and wrapping. Disabled rows (honest capability gating, DOR-109)
 * render but are never landed on. Returns `start` when every row is disabled.
 */
function findSelectableIndex(
  commands: RankedCommandEntry[],
  start: number,
  direction: 1 | -1
): number {
  const n = commands.length;
  if (n === 0) return 0;
  let idx = ((start % n) + n) % n;
  for (let i = 0; i < n; i++) {
    if (!commands[idx]?.disabled) return idx;
    idx = (idx + direction + n) % n;
  }
  return start;
}

interface UseCommandPaletteReturn {
  showCommands: boolean;
  setShowCommands: (v: boolean) => void;
  commandQuery: string;
  selectedIndex: number;
  filteredCommands: RankedCommandEntry[];
  slashTriggerPos: number;
  detectCommandTrigger: (value: string, cursor: number) => boolean;
  handleCommandSelect: (cmd: CommandEntry) => string;
  handleArrowUp: () => void;
  handleArrowDown: () => void;
  handleKeyboardSelect: () => string | null;
  resetCommand: () => void;
}

/**
 * Manages command palette state — trigger detection, fuzzy filtering, and keyboard navigation.
 */
export function useCommandPalette({
  commands,
  input,
  cursorPos: _cursorPos,
}: UseCommandPaletteOptions): UseCommandPaletteReturn {
  const [showCommands, setShowCommands] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [slashTriggerPos, setSlashTriggerPos] = useState(-1);

  const filteredCommands = useMemo<RankedCommandEntry[]>(() => {
    if (!commandQuery) return commands;
    // Rank each command across name, aliases, and description with the tiered
    // ranker so exact/prefix name hits surface first and alias matches (e.g.
    // typing `/stats` → `/usage`) rank sensibly — DOR-119/108.
    return commands
      .map((cmd) => ({ cmd, rank: rankCommand(commandQuery, cmd) }))
      .filter((r) => r.rank.match)
      .sort((a, b) => a.rank.bucket - b.rank.bucket || b.rank.score - a.rank.score)
      .map(({ cmd, rank }) => ({ ...cmd, matchedAlias: rank.matchedAlias }));
  }, [commands, commandQuery]);

  // Reset selectedIndex to the first selectable row when the filter changes or
  // the palette opens/closes.
  useEffect(() => {
    setSelectedIndex(findSelectableIndex(filteredCommands, 0, 1));
    // filteredCommands is derived from commandQuery; keying off the query keeps
    // the reset tied to user typing / open-close, not every list recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commandQuery, showCommands]);

  // Keep the selection on a selectable row: snap to the first enabled entry when
  // the current index falls out of range (list shrank) or points at a disabled
  // row (e.g. capabilities loaded and disabled the runtime-fulfilled intent).
  useEffect(() => {
    if (filteredCommands.length === 0) return;
    const current = filteredCommands[selectedIndex];
    if (!current || current.disabled) {
      setSelectedIndex(findSelectableIndex(filteredCommands, 0, 1));
    }
  }, [filteredCommands, selectedIndex]);

  /** Returns true if a command trigger was detected. */
  const detectCommandTrigger = useCallback((value: string, cursor: number): boolean => {
    const textToCursor = value.slice(0, cursor);
    const cmdMatch = textToCursor.match(/(^|\s)\/([\w:-]*)$/);
    if (cmdMatch) {
      setShowCommands(true);
      setCommandQuery(cmdMatch[2]);
      setSlashTriggerPos((cmdMatch.index ?? 0) + cmdMatch[1].length);
      return true;
    }
    setShowCommands(false);
    return false;
  }, []);

  /** Returns the new input value after inserting the selected command. */
  const handleCommandSelect = useCallback(
    (cmd: CommandEntry): string => {
      const before = input.slice(0, slashTriggerPos);
      setShowCommands(false);
      return before + cmd.fullCommand + ' ';
    },
    [input, slashTriggerPos]
  );

  const handleArrowDown = useCallback(() => {
    setSelectedIndex((prev) => findSelectableIndex(filteredCommands, prev + 1, 1));
  }, [filteredCommands]);

  const handleArrowUp = useCallback(() => {
    setSelectedIndex((prev) => findSelectableIndex(filteredCommands, prev - 1, -1));
  }, [filteredCommands]);

  /** Returns the new input value if a command was selected, or null. */
  const handleKeyboardSelect = useCallback((): string | null => {
    const cmd = filteredCommands[selectedIndex];
    // A disabled row (honest capability gating) is never selectable — leave the
    // palette open so the user can pick a supported command instead.
    if (cmd && !cmd.disabled) {
      return handleCommandSelect(cmd);
    }
    if (!cmd) setShowCommands(false);
    return null;
  }, [filteredCommands, selectedIndex, handleCommandSelect]);

  const resetCommand = useCallback(() => {
    setShowCommands(false);
    setCommandQuery('');
  }, []);

  return {
    showCommands,
    setShowCommands,
    commandQuery,
    selectedIndex,
    filteredCommands,
    slashTriggerPos,
    detectCommandTrigger,
    handleCommandSelect,
    handleArrowUp,
    handleArrowDown,
    handleKeyboardSelect,
    resetCommand,
  };
}
