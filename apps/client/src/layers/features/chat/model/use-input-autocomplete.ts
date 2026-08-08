import { useState, useCallback, useRef, useEffect } from 'react';
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
  /**
   * `id` of the listbox the open palette renders, or `undefined` when none is
   * open — the composer's `aria-controls`. Read off the same `show` flags that
   * decide which palette to draw, so it cannot point at an element that was
   * never rendered.
   */
  paletteListboxId: string | undefined;
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

  /**
   * The freshest `(value, cursor)` pair, as the field has reported it.
   *
   * ## Why a ref and not the state above
   *
   * Trigger detection needs BOTH halves, but each handler only carries one:
   * `handleInputChange` knows the new value and reads the cursor from state,
   * `handleCursorChange` knows the new cursor and reads the value from state.
   * When a field reports both in ONE tick — which is what
   * `TextareaField.handleChange` and Lexical's update listener both do — the
   * second handler still sees the pre-update state from its own closure, runs
   * detection against a half-stale pair, and undoes what the first just decided.
   *
   * The textarea never showed this: typing also fires a `select` event, so a
   * THIRD detection ran after the re-render with both halves fresh and quietly
   * repaired the result. A contenteditable emits no such event, so the repair
   * never came and `/` stopped opening the command palette (found in a browser,
   * DOR-948 task 5.2 — a bug in this hook, exposed rather than caused by the
   * new field).
   *
   * Refs make each handler contribute its own half and detect against the pair,
   * so the result no longer depends on how many events a field happens to fire.
   */
  const latest = useRef({ value: input, cursor: 0 });

  // The host owns the value too — it empties the box on send and writes a
  // dropped file path into it — and those never come through
  // `handleInputChange`. Syncing after commit keeps the ref honest without
  // fighting the in-tick writes above, which happen before any render.
  useEffect(() => {
    latest.current.value = input;
  }, [input]);

  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value);
      // A field that reports no cursor leaves the caret at the end of what it
      // just typed, which is where typing puts it.
      latest.current = { value, cursor: latest.current.cursor || value.length };
      detectTrigger(value, latest.current.cursor);
    },
    [setInput, detectTrigger]
  );

  const handleCursorChange = useCallback(
    (pos: number) => {
      setCursorPos(pos);
      latest.current = { value: latest.current.value, cursor: pos };
      detectTrigger(latest.current.value, pos);
    },
    [detectTrigger]
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

  // Mirrors the render order in ChatInputContainer: the file palette wins when
  // both flags are somehow set, exactly as the markup does.
  const paletteListboxId = fileComplete.showFiles
    ? 'file-palette-listbox'
    : cmdPalette.showCommands
      ? 'command-palette-listbox'
      : undefined;

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
    paletteListboxId,
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
