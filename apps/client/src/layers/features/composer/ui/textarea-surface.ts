/**
 * The {@link EditingSurface} adapter for a plain `<textarea>` — today's editing
 * code, moved behind the port character for character.
 *
 * Nothing here is new. The four helpers below used to sit at the top of
 * `use-input-keyboard.ts` and take the element directly; they now take it from
 * the ref this module closes over, and the ladder asks questions instead of
 * reaching in.
 *
 * @module features/composer/ui/textarea-surface
 */
import type { RefObject } from 'react';
import type { EditingSurface } from './editing-surface';

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

/**
 * Build the editing surface for a `<textarea>`.
 *
 * The returned object closes over the ref rather than the element, so it stays
 * valid across the mount that fills the ref in — which is what lets a host
 * build it once, with no dependencies, and hand the same object to the ladder
 * on every render.
 *
 * Every method tolerates a null element and answers the same way the ladder
 * used to answer for itself: the caret counts as being at both edges, and the
 * edits do nothing.
 *
 * @param ref - Ref to the textarea this surface edits.
 * @returns The surface the keyboard ladder talks to.
 */
export function createTextareaSurface(ref: RefObject<HTMLTextAreaElement | null>): EditingSurface {
  return {
    textBeforeCaret() {
      const el = ref.current;
      if (!el) return null;
      if (el.selectionStart !== el.selectionEnd) return null;
      return el.value.slice(0, el.selectionStart);
    },
    isCaretAtStart() {
      const el = ref.current;
      return !el || el.selectionStart === 0;
    },
    isCaretAtEnd() {
      const el = ref.current;
      return !el || el.selectionStart === el.value.length;
    },
    insertLineBreak() {
      const el = ref.current;
      if (el) insertTextAtCaret(el, '\n');
    },
    consumeEscapeIntoNewline() {
      const el = ref.current;
      if (el) consumeEscapeIntoNewline(el);
    },
    clearThroughUndoStack() {
      const el = ref.current;
      if (el) clearThroughUndoStack(el);
    },
    /**
     * Always `false`. A textarea has no editor-level composition state to ask:
     * the keydown's own flags (`isComposing`, and the legacy `keyCode` 229) are
     * the whole IME story on this surface, and the ladder already checks them.
     * This is not a stub waiting to be filled in — do not "fix" it.
     */
    isComposing() {
      return false;
    },
  };
}
