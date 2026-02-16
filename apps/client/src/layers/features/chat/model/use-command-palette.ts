import { useState, useEffect, useMemo, useCallback } from 'react';
import { fuzzyMatch } from '@/layers/shared/lib';
import type { CommandEntry } from '@dorkos/shared/types';

interface UseCommandPaletteOptions {
  commands: CommandEntry[];
  input: string;
  cursorPos: number;
}

interface UseCommandPaletteReturn {
  showCommands: boolean;
  setShowCommands: (v: boolean) => void;
  commandQuery: string;
  selectedIndex: number;
  filteredCommands: CommandEntry[];
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
  cursorPos,
}: UseCommandPaletteOptions): UseCommandPaletteReturn {
  const [showCommands, setShowCommands] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [slashTriggerPos, setSlashTriggerPos] = useState(-1);

  const filteredCommands = useMemo(() => {
    if (!commandQuery) return commands;
    return commands
      .map((cmd) => {
        const searchText = `${cmd.fullCommand} ${cmd.description}`;
        const result = fuzzyMatch(commandQuery, searchText);
        return { cmd, ...result };
      })
      .filter((r) => r.match)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.cmd);
  }, [commands, commandQuery]);

  // Reset selectedIndex when filter changes or palette opens/closes
  useEffect(() => {
    setSelectedIndex(0);
  }, [commandQuery, showCommands]);

  // Clamp selectedIndex when filteredCommands shrinks
  useEffect(() => {
    if (filteredCommands.length > 0 && selectedIndex >= filteredCommands.length) {
      setSelectedIndex(filteredCommands.length - 1);
    }
  }, [filteredCommands.length, selectedIndex]);

  /** Returns true if a command trigger was detected. */
  const detectCommandTrigger = useCallback(
    (value: string, cursor: number): boolean => {
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
    },
    []
  );

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
    setSelectedIndex((prev) =>
      filteredCommands.length === 0 ? 0 : (prev + 1) % filteredCommands.length
    );
  }, [filteredCommands.length]);

  const handleArrowUp = useCallback(() => {
    setSelectedIndex((prev) =>
      filteredCommands.length === 0
        ? 0
        : (prev - 1 + filteredCommands.length) % filteredCommands.length
    );
  }, [filteredCommands.length]);

  /** Returns the new input value if a command was selected, or null. */
  const handleKeyboardSelect = useCallback((): string | null => {
    if (filteredCommands.length > 0 && selectedIndex < filteredCommands.length) {
      return handleCommandSelect(filteredCommands[selectedIndex]);
    }
    setShowCommands(false);
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
