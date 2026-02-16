import { useState, useEffect, useMemo, useCallback } from 'react';
import { fuzzyMatch } from '@/layers/shared/lib';
import type { FileEntry } from '@/layers/features/files';

interface UseFileAutocompleteOptions {
  fileEntries: FileEntry[];
  input: string;
  cursorPos: number;
}

interface UseFileAutocompleteReturn {
  showFiles: boolean;
  setShowFiles: (v: boolean) => void;
  fileQuery: string;
  fileSelectedIndex: number;
  filteredFiles: (FileEntry & { indices: number[] })[];
  fileTriggerPos: number;
  detectFileTrigger: (value: string, cursor: number) => boolean;
  handleFileSelect: (entry: FileEntry) => { newValue: string; newCursorPos?: number; keepOpen: boolean };
  handleArrowUp: () => void;
  handleArrowDown: () => void;
  handleKeyboardSelect: () => { newValue: string; newCursorPos?: number; keepOpen: boolean } | null;
  resetFiles: () => void;
}

/**
 * Manages file autocomplete state — @-trigger detection, fuzzy filtering, and keyboard navigation.
 */
export function useFileAutocomplete({
  fileEntries,
  input,
  cursorPos,
}: UseFileAutocompleteOptions): UseFileAutocompleteReturn {
  const [showFiles, setShowFiles] = useState(false);
  const [fileQuery, setFileQuery] = useState('');
  const [fileSelectedIndex, setFileSelectedIndex] = useState(0);
  const [fileTriggerPos, setFileTriggerPos] = useState(-1);

  const filteredFiles = useMemo(() => {
    if (!showFiles) return [];
    if (!fileQuery)
      return fileEntries.slice(0, 50).map((e) => ({ ...e, indices: [] as number[] }));
    return fileEntries
      .map((entry) => ({ ...entry, ...fuzzyMatch(fileQuery, entry.path) }))
      .filter((r) => r.match)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
  }, [fileEntries, fileQuery, showFiles]);

  // Reset selectedIndex when filter changes or palette opens/closes
  useEffect(() => {
    setFileSelectedIndex(0);
  }, [fileQuery, showFiles]);

  // Clamp fileSelectedIndex when filteredFiles shrinks
  useEffect(() => {
    if (filteredFiles.length > 0 && fileSelectedIndex >= filteredFiles.length) {
      setFileSelectedIndex(filteredFiles.length - 1);
    }
  }, [filteredFiles.length, fileSelectedIndex]);

  /** Returns true if a file trigger was detected. */
  const detectFileTrigger = useCallback(
    (value: string, cursor: number): boolean => {
      const textToCursor = value.slice(0, cursor);
      const fileMatch = textToCursor.match(/(^|\s)@([\w./:-]*)$/);
      if (fileMatch) {
        setShowFiles(true);
        setFileQuery(fileMatch[2]);
        setFileTriggerPos((fileMatch.index ?? 0) + fileMatch[1].length);
        return true;
      }
      setShowFiles(false);
      return false;
    },
    []
  );

  /** Returns the new input value and whether to keep the palette open (for directory drill-down). */
  const handleFileSelect = useCallback(
    (entry: FileEntry): { newValue: string; newCursorPos?: number; keepOpen: boolean } => {
      const before = input.slice(0, fileTriggerPos);
      const after = input.slice(fileTriggerPos + 1 + fileQuery.length); // +1 for @

      if (entry.isDirectory) {
        const newValue = before + '@' + entry.path + after;
        const newCursorPos = before.length + 1 + entry.path.length;
        setFileQuery(entry.path);
        setFileSelectedIndex(0);
        return { newValue, newCursorPos, keepOpen: true };
      }

      const newValue = before + '@' + entry.path + ' ' + after;
      setShowFiles(false);
      return { newValue, keepOpen: false };
    },
    [input, fileTriggerPos, fileQuery]
  );

  const handleArrowDown = useCallback(() => {
    setFileSelectedIndex((prev) =>
      filteredFiles.length === 0 ? 0 : (prev + 1) % filteredFiles.length
    );
  }, [filteredFiles.length]);

  const handleArrowUp = useCallback(() => {
    setFileSelectedIndex((prev) =>
      filteredFiles.length === 0 ? 0 : (prev - 1 + filteredFiles.length) % filteredFiles.length
    );
  }, [filteredFiles.length]);

  /** Returns the selection result if a file was selected, or null. */
  const handleKeyboardSelect = useCallback((): {
    newValue: string;
    newCursorPos?: number;
    keepOpen: boolean;
  } | null => {
    if (filteredFiles.length > 0 && fileSelectedIndex < filteredFiles.length) {
      return handleFileSelect(filteredFiles[fileSelectedIndex]);
    }
    setShowFiles(false);
    return null;
  }, [filteredFiles, fileSelectedIndex, handleFileSelect]);

  const resetFiles = useCallback(() => {
    setShowFiles(false);
    setFileQuery('');
  }, []);

  return {
    showFiles,
    setShowFiles,
    fileQuery,
    fileSelectedIndex,
    filteredFiles,
    fileTriggerPos,
    detectFileTrigger,
    handleFileSelect,
    handleArrowUp,
    handleArrowDown,
    handleKeyboardSelect,
    resetFiles,
  };
}
