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
  /**
   * Stop the in-flight upload. Escape reaches for this exactly as it reaches for
   * `onStop` during a turn: the upload IS the send, so the key that stops a send
   * has to stop this one too.
   */
  onCancelUpload?: () => void;
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
  /**
   * Whether Tab picks the highlighted row alongside Enter. Defaults to `true`.
   *
   * True is right for a palette the person ASKED for — typing `/` or `@` is a
   * request to complete something, and Tab is how completion has always been
   * taken. It is wrong for one that appears on its own: the home composer's
   * "Jump back in" panel floats up merely because the caret arrived in an empty
   * box, and a Tab meant to move to the next control would have opened a thread
   * instead. Passing `false` leaves Enter as the only pick key and lets Tab do
   * what it does everywhere else.
   */
  tabPicks?: boolean;
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
  /**
   * Identifies the draft the composer is holding — the session/cwd pair for the
   * chat composer, `undefined` for hosts that have neither. A change disarms the
   * pending double-Escape: the arm belongs to the text that was on screen when
   * the first tap landed, and the composer is re-rendered rather than remounted
   * on a session switch, so without this an arm from session A could wipe
   * session B's draft on a single tap.
   */
  contextKey?: string;
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
  onCancelUpload,
  commandPending = false,
  canSubmit = true,
  editingQueueItem,
  isPaletteOpen,
  paletteHasResults = false,
  tabPicks = true,
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
  contextKey,
}: UseInputKeyboardOptions): UseInputKeyboardReturn {
  // The arm remembers WHICH draft it was raised against, not merely that it was
  // raised. Switching sessions re-renders this composer rather than remounting
  // it, so a bare boolean would still be live against the next session's text —
  // one tap, and words nobody armed are gone. Storing the context makes that
  // expire by derivation, with no effect to run and no extra render.
  const [armedContext, setArmedContext] = useState<string | null>(null);
  const disarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearArmed = armedContext !== null && armedContext === (contextKey ?? '');

  const disarm = useCallback(() => {
    if (disarmTimerRef.current !== null) clearTimeout(disarmTimerRef.current);
    disarmTimerRef.current = null;
    setArmedContext(null);
  }, []);

  // The timer IS the window — there is no second clock to drift against it.
  const arm = useCallback(() => {
    if (disarmTimerRef.current !== null) clearTimeout(disarmTimerRef.current);
    setArmedContext(contextKey ?? '');
    disarmTimerRef.current = setTimeout(() => {
      disarmTimerRef.current = null;
      setArmedContext(null);
    }, DOUBLE_ESCAPE_THRESHOLD_MS);
  }, [contextKey]);

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
      // palette dismiss → cancel queue edit → stop streaming → cancel upload →
      // double-tap clear.
      //
      // **A rung that acts CONSUMES the key, and says so with `preventDefault`.**
      // Escape has no default browser action in a textarea, so this is not about
      // suppressing one — it is the signal an enclosing surface reads to find out
      // whether the key was already spoken for. The thread panel closes on
      // Escape, and without this an Escape aimed at the mention palette dismissed
      // the palette AND shut the whole thread, losing the reader's place for a
      // keystroke that had already done its job.
      //
      // `preventDefault` and deliberately NOT `stopPropagation`: an ancestor that
      // does not check `defaultPrevented` keeps behaving exactly as it did, so
      // this cannot silently break a dialog that closes on a bubbled Escape.
      // Marking is a claim about what happened, not a veto on who else hears it.
      if (e.key === 'Escape') {
        if (isPaletteOpen) {
          onEscape?.();
          e.preventDefault();
          // Deliberately no arming: closing a palette must not arm the
          // draft-wiping second Escape. Clearing takes two bare taps.
          return;
        }
        if (editingQueueItem) {
          onCancelEdit?.();
          e.preventDefault();
          return;
        }
        if (isStreaming) {
          onStop?.();
          e.preventDefault();
          return;
        }
        // An upload in flight is this send, already happening — so the key that
        // stops a send stops it, on the same rung Stop sits on.
        if (isUploading && onCancelUpload) {
          onCancelUpload();
          e.preventDefault();
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
          e.preventDefault();
        } else {
          onEscape?.();
          arm();
          // Arming only counts as consuming the key when there is something to
          // wipe: that is the case that puts a hint on screen, so the keystroke
          // visibly did something. Escape in an EMPTY composer changes nothing a
          // reader can see, and must stay available to the surface around it —
          // otherwise a thread panel could never be closed from its own box.
          if (value.trim()) e.preventDefault();
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
        //
        // Tab is a pick key only where the host says so (`tabPicks`): a palette
        // that opened on its own must not swallow the key that moves focus on.
        if (
          paletteHasResults &&
          ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && tabPicks))
        ) {
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
      onCancelUpload,
      commandPending,
      value,
      onSubmit,
      onStop,
      onEscape,
      onClear,
      isPaletteOpen,
      paletteHasResults,
      tabPicks,
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
