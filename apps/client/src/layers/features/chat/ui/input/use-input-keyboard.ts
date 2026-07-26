import { useRef, useCallback, useEffect, useState } from 'react';
import type { RefObject } from 'react';

/**
 * How long the first bare Escape stays armed, so the second one clears.
 *
 * The single source of truth for the whole double-tap: the timer below both
 * closes the window and takes the on-screen readout down with it, so the hint
 * cannot outlive the shortcut it advertises.
 */
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

/**
 * Empty the field through the browser's own editing pipeline, so the wipe lands
 * as ONE undo entry and Cmd+Z brings the draft back.
 *
 * Same reasoning as {@link insertTextAtCaret}, and the same seam: rewriting the
 * controlled value with `setState` is invisible to the field's native undo
 * stack. That matters more here than anywhere else in this file — this clear
 * sits two taps behind a key someone is already hammering to stop a turn that
 * will not stop.
 */
function clearThroughUndoStack(textarea: HTMLTextAreaElement): void {
  textarea.focus();
  textarea.setSelectionRange(0, textarea.value.length);
  document.execCommand('insertText', false, '');
}

interface UseInputKeyboardOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  isStreaming: boolean;
  /**
   * Whether touch is the ONLY pointer — a coarse primary pointer and no fine
   * pointer anywhere. Decides what Enter means: a newline where the send button
   * is the only sane target, and a send everywhere else.
   *
   * Not "the primary pointer is coarse": a tablet with a trackpad reports a
   * coarse primary pointer and still deserves Enter-to-send. Not viewport width
   * either, so dragging a desktop window narrow cannot rewrite the contract.
   * See {@link import('@/layers/shared/model').useIsTouchOnly}.
   */
  isTouchOnly: boolean;
  sessionBusy: boolean;
  /** An attachment upload is in flight — this send is already happening. */
  isUploading?: boolean;
  /** A dispatched native command has not settled — its text is still in the box. */
  commandPending?: boolean;
  /** When false, the Enter key does not submit (the send target is not ready). Defaults to true. */
  canSubmit?: boolean;
  editingQueueItem: boolean;
  isPaletteOpen?: boolean;
  /**
   * Whether the open palette has at least one row. An open palette showing "No
   * commands found." has nothing for Enter to pick, so Enter must fall through
   * and send instead of being swallowed. Defaults to `false`.
   */
  paletteHasResults?: boolean;
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

interface UseInputKeyboardReturn {
  handleKeyDown: (e: React.KeyboardEvent) => void;
  /**
   * `true` for exactly as long as a second Escape would clear the draft.
   *
   * The first bare Escape has no other effect, so without this the capability
   * was unreachable: nothing moved, and nobody tries a key twice that appeared
   * to do nothing once. The composer renders this as a transient readout, which
   * is why the flag is state rather than the ref it used to be.
   */
  clearArmed: boolean;
}

/** Keyboard handler for the chat input textarea. */
export function useInputKeyboard({
  textareaRef,
  value,
  isStreaming,
  isTouchOnly,
  sessionBusy,
  isUploading = false,
  commandPending = false,
  canSubmit = true,
  editingQueueItem,
  isPaletteOpen,
  paletteHasResults = false,
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
}: UseInputKeyboardOptions): UseInputKeyboardReturn {
  const [clearArmed, setClearArmed] = useState(false);
  const disarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = useCallback(() => {
    if (disarmTimerRef.current !== null) clearTimeout(disarmTimerRef.current);
    disarmTimerRef.current = null;
    setClearArmed(false);
  }, []);

  // The timer IS the window — there is no second clock to drift against it.
  const arm = useCallback(() => {
    if (disarmTimerRef.current !== null) clearTimeout(disarmTimerRef.current);
    setClearArmed(true);
    disarmTimerRef.current = setTimeout(() => {
      disarmTimerRef.current = null;
      setClearArmed(false);
    }, DOUBLE_ESCAPE_THRESHOLD_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (disarmTimerRef.current !== null) clearTimeout(disarmTimerRef.current);
    };
  }, []);

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
          // Deliberately no arming: closing a palette must not arm the
          // draft-wiping second Escape. Clearing takes two bare taps.
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
        if (value.trim() && clearArmed) {
          // Wipe through the field's own editing pipeline first, so the draft is
          // one Cmd+Z away. `onClear` still runs for whatever the host hangs off
          // it (dismissing a palette); the state write it performs is the same
          // empty string the native `input` event already produced.
          const textarea = textareaRef.current;
          if (textarea) clearThroughUndoStack(textarea);
          onClear?.();
          disarm();
        } else {
          onEscape?.();
          arm();
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
        // Only intercept the pick keys when there is something to pick. A
        // palette showing "No commands found." (type `/zzz`, or `@zzz`) used to
        // eat the Enter, close itself, and send nothing — so the message needed
        // two presses of the same key.
        if (paletteHasResults && ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab')) {
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
      // Fine pointer: Enter submits/queues/saves; Shift+Enter for a newline.
      // Coarse pointer: Enter inserts a newline, submit via the button only.
      if (e.key === 'Enter' && !e.shiftKey && !isTouchOnly) {
        e.preventDefault();
        // A dispatched command is still settling, and its text is still in the
        // box precisely so a refusal does not eat it. Without this, pressing
        // Enter again fires the same `/compact` a second time.
        if (commandPending) return;
        if (editingQueueItem && value.trim()) {
          onSaveEdit?.();
        } else if (isStreaming && value.trim()) {
          onQueue?.();
        } else if (!isStreaming && !sessionBusy && !isUploading && canSubmit && value.trim()) {
          // `!isUploading` is the second half of the trigger latch: the send's
          // attachment upload runs BEFORE the session reads as streaming, so
          // without this a second Enter mid-upload starts a whole second send.
          onSubmit();
        }
      }
    },
    [
      isStreaming,
      isTouchOnly,
      isUploading,
      commandPending,
      value,
      onSubmit,
      onStop,
      onEscape,
      onClear,
      isPaletteOpen,
      paletteHasResults,
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
      clearArmed,
      arm,
      disarm,
    ]
  );

  return { handleKeyDown, clearArmed };
}
