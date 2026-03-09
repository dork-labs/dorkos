import { useState, useCallback, type RefObject } from 'react';
import type { CommandEntry } from '@dorkos/shared/types';
import type { FileEntry } from '@/layers/shared/lib';
import { useCommandPalette } from './use-command-palette';
import { useFileAutocomplete } from './use-file-autocomplete';
import type { ChatInputHandle } from '../ui/ChatInput';

interface UseInputAutocompleteOptions {
  input: string;
  setInput: (v: string) => void;
  commands: CommandEntry[];
  fileEntries: FileEntry[];
  chatInputRef: RefObject<ChatInputHandle | null>;
}

interface UseInputAutocompleteReturn {
  commands: {
    show: boolean;
    filtered: CommandEntry[];
    selectedIndex: number;
  };
  files: {
    show: boolean;
    filtered: (FileEntry & { indices: number[] })[];
    selectedIndex: number;
  };
  isPaletteOpen: boolean;
  activeDescendantId: string | undefined;
  handleInputChange: (value: string) => void;
  handleCursorChange: (pos: number) => void;
  handleArrowUp: () => void;
  handleArrowDown: () => void;
  handleKeyboardSelect: () => void;
  handleCommandSelect: (cmd: CommandEntry) => void;
  handleFileSelect: (entry: FileEntry) => void;
  handleChipClick: (trigger: string) => void;
  dismissPalettes: () => void;
}

/**
 * Coordinate command palette and file autocomplete — trigger detection,
 * keyboard navigation, selection, and chip toggling.
 */
export function useInputAutocomplete({
  input,
  setInput,
  commands,
  fileEntries,
  chatInputRef,
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
    [fileComplete.detectFileTrigger, cmdPalette.detectCommandTrigger, fileComplete.setShowFiles, cmdPalette.setShowCommands]
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
    [cmdPalette.handleCommandSelect, setInput]
  );

  const handleFileSelect = useCallback(
    (entry: FileEntry) => {
      const result = fileComplete.handleFileSelect(entry);
      setInput(result.newValue);
      if (result.newCursorPos !== undefined) {
        setCursorPos(result.newCursorPos);
      }
    },
    [fileComplete.handleFileSelect, setInput]
  );

  const handleArrowDown = useCallback(() => {
    if (fileComplete.showFiles) {
      fileComplete.handleArrowDown();
    } else {
      cmdPalette.handleArrowDown();
    }
  }, [fileComplete.showFiles, fileComplete.handleArrowDown, cmdPalette.handleArrowDown]);

  const handleArrowUp = useCallback(() => {
    if (fileComplete.showFiles) {
      fileComplete.handleArrowUp();
    } else {
      cmdPalette.handleArrowUp();
    }
  }, [fileComplete.showFiles, fileComplete.handleArrowUp, cmdPalette.handleArrowUp]);

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
  }, [fileComplete.showFiles, cmdPalette.showCommands, fileComplete.handleKeyboardSelect, cmdPalette.handleKeyboardSelect, setInput]);

  const handleChipClick = useCallback(
    (trigger: string) => {
      const existingTrigger = input.match(/(^|\s)([/@])([\w./:-]*)$/);
      let newValue: string;

      if (existingTrigger) {
        const triggerChar = existingTrigger[2];
        const queryText = existingTrigger[3];
        const triggerStart = (existingTrigger.index ?? 0) + existingTrigger[1].length;

        if (triggerChar === trigger && !queryText) {
          const prefix = input.slice(0, triggerStart);
          newValue = prefix.endsWith(' ') && triggerStart > 0 ? prefix.slice(0, -1) : prefix;
          setInput(newValue);
          fileComplete.setShowFiles(false);
          cmdPalette.setShowCommands(false);
          requestAnimationFrame(() => chatInputRef.current?.focusAt(newValue.length));
          return;
        }
        newValue = input.slice(0, triggerStart) + trigger;
      } else if (input.length > 0 && !input.endsWith(' ')) {
        newValue = input + ' ' + trigger;
      } else {
        newValue = input + trigger;
      }

      setInput(newValue);
      detectTrigger(newValue, newValue.length);
      requestAnimationFrame(() => chatInputRef.current?.focusAt(newValue.length));
    },
    [input, setInput, detectTrigger, fileComplete.setShowFiles, cmdPalette.setShowCommands, chatInputRef]
  );

  const dismissPalettes = useCallback(() => {
    cmdPalette.setShowCommands(false);
    fileComplete.setShowFiles(false);
  }, [cmdPalette.setShowCommands, fileComplete.setShowFiles]);

  const isPaletteOpen = cmdPalette.showCommands || fileComplete.showFiles;

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
    activeDescendantId,
    handleInputChange,
    handleCursorChange,
    handleArrowUp,
    handleArrowDown,
    handleKeyboardSelect,
    handleCommandSelect,
    handleFileSelect,
    handleChipClick,
    dismissPalettes,
  };
}
