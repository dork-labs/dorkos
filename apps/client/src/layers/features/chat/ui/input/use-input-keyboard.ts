import { useRef, useCallback } from 'react';
import type { RefObject } from 'react';

const DOUBLE_ESCAPE_THRESHOLD_MS = 500;

/**
 * Legacy `keyCode` reported by browsers for a keystroke consumed by an active
 * IME composition. Some engines do not set `KeyboardEvent.isComposing` on the
 * keydown that commits a candidate, so both signals are checked.
 */
const IME_PROCESS_KEY_CODE = 229;

/** Count the consecutive `\` characters at the end of `text`. */
function countTrailingBackslashes(text: string): number {
  let count = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === '\\'; i -= 1) count += 1;
  return count;
}

/**
 * Whether the caret sits immediately after an escaping backslash, so Enter
 * should continue the line instead of sending.
 *
 * Shell semantics: an odd run of backslashes ends with an escape character, an
 * even run is escaped literals (`foo\\` still sends). The caret must be
 * collapsed and touching the backslash — `foo\ ` sends.
 */
function isEscapedNewline(textarea: HTMLTextAreaElement): boolean {
  if (textarea.selectionStart !== textarea.selectionEnd) return false;
  const before = textarea.value.slice(0, textarea.selectionStart);
  return countTrailingBackslashes(before) % 2 === 1;
}

/**
 * Insert text at the caret through the browser's own editing pipeline.
 *
 * `document.execCommand` is deprecated on paper but has no replacement and is
 * universally supported. It is the only way to edit a textarea that pushes a
 * real undo entry and fires a native `input` event — rewriting the controlled
 * value with `setState` instead would silently destroy the field's undo stack.
 */
function insertTextAtCaret(textarea: HTMLTextAreaElement, text: string): void {
  textarea.focus();
  document.execCommand('insertText', false, text);
}

/**
 * Replace the escaping backslash before the caret with a newline, so the
 * continuation leaves exactly the text the user typed minus the escape.
 */
function consumeEscapeIntoNewline(textarea: HTMLTextAreaElement): void {
  const caret = textarea.selectionStart;
  textarea.setSelectionRange(caret - 1, caret);
  insertTextAtCaret(textarea, '\n');
}

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
      // --- IME composition guard (must precede every other branch) ---
      // While an IME candidate window is open, Enter commits the candidate.
      // Acting on it here would send a half-typed message.
      if (e.nativeEvent.isComposing || e.keyCode === IME_PROCESS_KEY_CODE) return;

      // --- Escape priority ladder ---
      // palette dismiss → cancel queue edit → stop streaming → double-tap clear.
      if (e.key === 'Escape') {
        if (isPaletteOpen) {
          onEscape?.();
          // Deliberately no `lastEscapeRef` stamp: closing a palette must not
          // arm the draft-wiping second Escape. Clearing takes two bare taps.
          return;
        }
        if (editingQueueItem) {
          onCancelEdit?.();
          return;
        }
        if (isStreaming) {
          onStop?.();
          return;
        }
        const now = Date.now();
        if (value.trim() && now - lastEscapeRef.current < DOUBLE_ESCAPE_THRESHOLD_MS) {
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

      // --- Option/Alt+Enter: an explicit newline, never a palette pick or a send ---
      // Shift+Enter is left to the browser, which already inserts a newline (and
      // its own undo entry). Alt+Enter has no native effect, so insert it here.
      if (e.key === 'Enter' && e.altKey) {
        e.preventDefault();
        const textarea = textareaRef.current;
        if (textarea) insertTextAtCaret(textarea, '\n');
        return;
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

      // --- Backslash line continuation (upstream of all three Enter modes) ---
      // `foo\` + Enter never submits, never queues, and never saves an edit — on
      // every platform, so the resulting text is identical on mobile (where a
      // bare Enter is already a newline) as on desktop.
      if (e.key === 'Enter' && !e.shiftKey) {
        const textarea = textareaRef.current;
        if (textarea && isEscapedNewline(textarea)) {
          e.preventDefault();
          consumeEscapeIntoNewline(textarea);
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
