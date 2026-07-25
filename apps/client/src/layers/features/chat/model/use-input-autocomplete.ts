import { useState, useCallback } from 'react';
import type { CommandEntry } from '@dorkos/shared/types';
import type { FileEntry } from '@/layers/shared/lib';
import type { PaletteCommandEntry, RankedCommandEntry } from '@/layers/entities/command';
import { useCommandPalette } from './use-command-palette';
import { useFileAutocomplete } from './use-file-autocomplete';

interface UseInputAutocompleteOptions {
  input: string;
  setInput: (v: string) => void;
  commands: PaletteCommandEntry[];
  fileEntries: FileEntry[];
}

interface UseInputAutocompleteReturn {
  commands: {
    show: boolean;
    filtered: RankedCommandEntry[];
    selectedIndex: number;
  };
  files: {
    show: boolean;
    filtered: (FileEntry & { indices: number[] })[];
    selectedIndex: number;
  };
  isPaletteOpen: boolean;
  /**
   * Whether the open palette actually has rows. Distinct from
   * {@link UseInputAutocompleteReturn.isPaletteOpen}, which stays true for the
   * "No commands found." panel: that panel has nothing for Enter to select, so
   * Enter must reach the send path instead of being swallowed.
   */
  paletteHasResults: boolean;
  activeDescendantId: string | undefined;
  handleInputChange: (value: string) => void;
  handleCursorChange: (pos: number) => void;
  handleArrowUp: () => void;
  handleArrowDown: () => void;
  handleKeyboardSelect: () => void;
  handleCommandSelect: (cmd: CommandEntry) => void;
  handleFileSelect: (entry: FileEntry) => void;
  dismissPalettes: () => void;
}

/**
 * Coordinate command palette and file autocomplete — trigger detection,
 * keyboard navigation, and selection.
 */
export function useInputAutocomplete({
  input,
  setInput,
  commands,
  fileEntries,
}: UseInputAutocompleteOptions): UseInputAutocompleteReturn {
  const [cursorPos, setCursorPos] = useState(0);

  const cmdPalette = useCommandPalette({ commands, input, cursorPos });
  const fileComplete = useFileAutocomplete({ fileEntries, input, cursorPos });

  const detectTrigger = useCallback(
    (value: string, cursor: number) => {
      // Check @ file trigger first
      if (fileComplete.detectFileTrigger(value, cursor)) {
        cmdPalette.setShowCommands(false);
        return;
      }
      // Then / command trigger
      if (cmdPalette.detectCommandTrigger(value, cursor)) {
        fileComplete.setShowFiles(false);
        return;
      }
      fileComplete.setShowFiles(false);
      cmdPalette.setShowCommands(false);
    },
    [fileComplete, cmdPalette]
  );

  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value);
      detectTrigger(value, cursorPos || value.length);
    },
    [setInput, detectTrigger, cursorPos]
  );

  const handleCursorChange = useCallback(
    (pos: number) => {
      setCursorPos(pos);
      detectTrigger(input, pos);
    },
    [input, detectTrigger]
  );

  const handleCommandSelect = useCallback(
    (cmd: CommandEntry) => {
      const newValue = cmdPalette.handleCommandSelect(cmd);
      setInput(newValue);
    },
    [cmdPalette, setInput]
  );

  const handleFileSelect = useCallback(
    (entry: FileEntry) => {
      const result = fileComplete.handleFileSelect(entry);
      setInput(result.newValue);
      if (result.newCursorPos !== undefined) {
        setCursorPos(result.newCursorPos);
      }
    },
    [fileComplete, setInput]
  );

  const handleArrowDown = useCallback(() => {
    if (fileComplete.showFiles) {
      fileComplete.handleArrowDown();
    } else {
      cmdPalette.handleArrowDown();
    }
  }, [fileComplete, cmdPalette]);

  const handleArrowUp = useCallback(() => {
    if (fileComplete.showFiles) {
      fileComplete.handleArrowUp();
    } else {
      cmdPalette.handleArrowUp();
    }
  }, [fileComplete, cmdPalette]);

  const handleKeyboardSelect = useCallback(() => {
    if (fileComplete.showFiles) {
      const result = fileComplete.handleKeyboardSelect();
      if (result) {
        setInput(result.newValue);
        if (result.newCursorPos !== undefined) {
          setCursorPos(result.newCursorPos);
        }
      }
    } else if (cmdPalette.showCommands) {
      const newValue = cmdPalette.handleKeyboardSelect();
      if (newValue) {
        setInput(newValue);
      }
    }
  }, [fileComplete, cmdPalette, setInput]);

  const dismissPalettes = useCallback(() => {
    cmdPalette.setShowCommands(false);
    fileComplete.setShowFiles(false);
  }, [cmdPalette, fileComplete]);

  const isPaletteOpen = cmdPalette.showCommands || fileComplete.showFiles;
  const paletteHasResults =
    (fileComplete.showFiles && fileComplete.filteredFiles.length > 0) ||
    (cmdPalette.showCommands && cmdPalette.filteredCommands.length > 0);

  const activeDescendantId =
    fileComplete.showFiles && fileComplete.filteredFiles.length > 0
      ? `file-item-${fileComplete.fileSelectedIndex}`
      : cmdPalette.showCommands && cmdPalette.filteredCommands.length > 0
        ? `command-item-${cmdPalette.selectedIndex}`
        : undefined;

  return {
    commands: {
      show: cmdPalette.showCommands,
      filtered: cmdPalette.filteredCommands,
      selectedIndex: cmdPalette.selectedIndex,
    },
    files: {
      show: fileComplete.showFiles,
      filtered: fileComplete.filteredFiles,
      selectedIndex: fileComplete.fileSelectedIndex,
    },
    isPaletteOpen,
    paletteHasResults,
    activeDescendantId,
    handleInputChange,
    handleCursorChange,
    handleArrowUp,
    handleArrowDown,
    handleKeyboardSelect,
    handleCommandSelect,
    handleFileSelect,
    dismissPalettes,
  };
}
