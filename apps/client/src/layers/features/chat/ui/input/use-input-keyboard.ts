import { useRef, useCallback } from 'react';
import type { RefObject } from 'react';

const DOUBLE_ESCAPE_THRESHOLD_MS = 500;

interface UseInputKeyboardOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  isStreaming: boolean;
  isMobile: boolean;
  sessionBusy: boolean;
  /** When false, the Enter key does not submit (the send target is not ready). Defaults to true. */
  canSubmit?: boolean;
  editingQueueItem: boolean;
  isPaletteOpen?: boolean;
  queueHasItems: boolean;
  onSubmit: () => void;
  onStop?: () => void;
  onEscape?: () => void;
  onClear?: () => void;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
  onCommandSelect?: () => void;
  onQueue?: () => void;
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
  onQueueNavigateUp?: () => void;
  onQueueNavigateDown?: () => void;
}

/** Keyboard handler for the chat input textarea. */
export function useInputKeyboard({
  textareaRef,
  value,
  isStreaming,
  isMobile,
  sessionBusy,
  canSubmit = true,
  editingQueueItem,
  isPaletteOpen,
  queueHasItems,
  onSubmit,
  onStop,
  onEscape,
  onClear,
  onArrowUp,
  onArrowDown,
  onCommandSelect,
  onQueue,
  onSaveEdit,
  onCancelEdit,
  onQueueNavigateUp,
  onQueueNavigateDown,
}: UseInputKeyboardOptions) {
  const lastEscapeRef = useRef(0);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Escape while streaming stops generation (highest priority)
      if (e.key === 'Escape' && isStreaming) {
        onStop?.();
        return;
      }

      // Escape while editing a queue item cancels the edit
      if (e.key === 'Escape' && editingQueueItem) {
        onCancelEdit?.();
        return;
      }

      if (e.key === 'Escape') {
        const now = Date.now();
        if (isPaletteOpen) {
          onEscape?.();
          lastEscapeRef.current = now;
        } else if (value.trim() && now - lastEscapeRef.current < DOUBLE_ESCAPE_THRESHOLD_MS) {
          onClear?.();
          lastEscapeRef.current = 0;
        } else {
          onEscape?.();
          lastEscapeRef.current = now;
        }
        return;
      }

      // --- Queue navigation (priority over palette when queue has items and palette closed) ---
      if (!isPaletteOpen && queueHasItems) {
        if (e.key === 'ArrowUp') {
          const textarea = textareaRef.current;
          const isAtStart = !textarea || textarea.selectionStart === 0;
          if (!value.trim() || isAtStart) {
            e.preventDefault();
            onQueueNavigateUp?.();
            return;
          }
        }
        if (e.key === 'ArrowDown') {
          const textarea = textareaRef.current;
          const isAtEnd = !textarea || textarea.selectionStart === textarea.value.length;
          if (editingQueueItem && isAtEnd) {
            e.preventDefault();
            onQueueNavigateDown?.();
            return;
          }
        }
      }

      // --- Palette-open interceptions ---
      if (isPaletteOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          onArrowDown?.();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          onArrowUp?.();
          return;
        }
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
          e.preventDefault();
          onCommandSelect?.();
          return;
        }
      }

      // --- Default Enter behavior (palette closed) ---
      // Desktop: Enter submits/queues/saves; Shift+Enter for newline
      // Mobile: Enter inserts newline, submit via button only
      if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
        e.preventDefault();
        if (editingQueueItem && value.trim()) {
          onSaveEdit?.();
        } else if (isStreaming && value.trim()) {
          onQueue?.();
        } else if (!isStreaming && !sessionBusy && canSubmit && value.trim()) {
          onSubmit();
        }
      }
    },
    [
      isStreaming,
      isMobile,
      value,
      onSubmit,
      onStop,
      onEscape,
      onClear,
      isPaletteOpen,
      onArrowUp,
      onArrowDown,
      onCommandSelect,
      editingQueueItem,
      onQueue,
      onSaveEdit,
      onCancelEdit,
      queueHasItems,
      onQueueNavigateUp,
      onQueueNavigateDown,
      sessionBusy,
      canSubmit,
      textareaRef,
    ]
  );

  return handleKeyDown;
}
