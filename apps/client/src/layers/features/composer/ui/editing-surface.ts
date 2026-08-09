/**
 * The port between the composer's keyboard ladder and whatever it is editing.
 *
 * **Why a port at all.** The ladder used to reach straight into
 * `textareaRef.current` — five times, for the text before the caret, the two
 * caret-at-edge checks, the Alt+Enter line break, the backslash continuation,
 * and the double-Escape wipe. A second kind of field cannot satisfy any of
 * them. React 19 delegates its synthetic listeners to the root container, while
 * a rich-text editor registers native listeners on the editable element itself
 * and acts in the target phase; without a seam the ladder either reaches into a
 * `<textarea>` that is not there, or gets consulted after the editor has
 * already inserted a paragraph and the message never sends.
 *
 * **Why exactly these seven.** Everything else the ladder decides from props
 * alone — whether a palette is open, whether a turn is streaming, what Enter
 * means on this device. Only these seven questions are about the document under
 * the caret. Every method added here is a new way for two surfaces to diverge
 * while both stay green, so the count is a budget, not a starting point: keep
 * it at seven.
 *
 * @module features/composer/ui/editing-surface
 */

/**
 * The seven things the keyboard ladder needs from whatever it is editing.
 *
 * Deliberately tiny; see this module's documentation for why it exists and why
 * it stops at seven.
 */
export interface EditingSurface {
  /** Text before a COLLAPSED caret, or `null` when the selection is a range. */
  textBeforeCaret(): string | null;
  /** Caret at offset 0 of the whole document (ArrowUp into the queue). */
  isCaretAtStart(): boolean;
  /** Caret at the very end of the whole document (ArrowDown out of an edit). */
  isCaretAtEnd(): boolean;
  /** Insert a hard line break at the caret, pushing one undo entry (Alt+Enter). */
  insertLineBreak(): void;
  /** Replace the escaping backslash before the caret with a newline. */
  consumeEscapeIntoNewline(): void;
  /** Empty the field as ONE undo entry, so Cmd+Z brings the draft back. */
  clearThroughUndoStack(): void;
  /** Whether an IME composition is in progress on this surface. */
  isComposing(): boolean;
}

/**
 * The surface a composer holds before its field has reported one.
 *
 * A field cannot hand its surface up until it has mounted — and a rich-text
 * field not until its editor exists, which is after first paint. Nobody can
 * press a key in that window, so every answer here is the same one the ladder
 * gave itself when there was no element yet: the caret counts as being at both
 * edges, there is no text before it, and the edits do nothing.
 */
export const INERT_SURFACE: EditingSurface = {
  textBeforeCaret: () => null,
  isCaretAtStart: () => true,
  isCaretAtEnd: () => true,
  insertLineBreak: () => {},
  consumeEscapeIntoNewline: () => {},
  clearThroughUndoStack: () => {},
  isComposing: () => false,
};
