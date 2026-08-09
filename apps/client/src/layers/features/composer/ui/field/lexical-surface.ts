/**
 * The {@link EditingSurface} adapter for a Lexical editor — the second
 * implementation of the port, and the reason the port exists.
 *
 * Every method runs inside `editor.read()` or `editor.update()` and works
 * through `$getSelection` / `$isRangeSelection`. None of the textarea's five
 * reach-ins has any meaning here, which is exactly why the keyboard ladder was
 * taught to ask instead of reach.
 *
 * @module features/composer/ui/field/lexical-surface
 */
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  type LexicalEditor,
} from 'lexical';
import type { EditingSurface } from '../editing-surface';
import {
  $markdownOffsetOfSelection,
  $selectMarkdownOffset,
  $serializeWithOffsets,
} from './markdown-offsets';

/**
 * Build the editing surface for a Lexical editor.
 *
 * @param editor - The editor this surface edits.
 * @returns The surface the keyboard ladder talks to.
 */
export function createLexicalSurface(editor: LexicalEditor): EditingSurface {
  return {
    /**
     * The markdown before a collapsed caret.
     *
     * Taken from the serialized document rather than from `getTextContent()`,
     * so the backslash-continuation rule sees the SAME string a textarea would.
     * A text walk would miss the four characters `**bold**` contributes, and
     * `foo**\` would stop continuing the line.
     */
    textBeforeCaret() {
      let before: string | null = null;
      editor.getEditorState().read(() => {
        const doc = $serializeWithOffsets();
        const pos = $markdownOffsetOfSelection(doc);
        before = pos === null ? null : doc.markdown.slice(0, pos);
      });
      return before;
    },

    /**
     * Whether the caret sits at offset 0 of the WHOLE document.
     *
     * Not the current block: ArrowUp into the message queue means "there is
     * nothing above me", and a caret at the start of the second paragraph has
     * a paragraph above it.
     */
    isCaretAtStart() {
      let atStart = true;
      editor.getEditorState().read(() => {
        const doc = $serializeWithOffsets();
        const pos = $markdownOffsetOfSelection(doc);
        atStart = pos === null ? true : pos === 0;
      });
      return atStart;
    },

    /** The mirror of {@link EditingSurface.isCaretAtStart}. */
    isCaretAtEnd() {
      let atEnd = true;
      editor.getEditorState().read(() => {
        const doc = $serializeWithOffsets();
        const pos = $markdownOffsetOfSelection(doc);
        atEnd = pos === null ? true : pos === doc.markdown.length;
      });
      return atEnd;
    },

    /** One update, so `HistoryPlugin` records the break as one undo entry. */
    insertLineBreak() {
      editor.update(
        () => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) selection.insertLineBreak();
        },
        { discrete: true }
      );
    },

    /**
     * Delete the escaping backslash and insert a line break, in ONE update, so
     * Cmd+Z takes both back together rather than leaving a stray backslash.
     *
     * The backslash is removed by editing the anchor node rather than through
     * `selection.modify` or `deleteCharacter`: both of those delegate to the
     * browser's native `Selection.modify`, which ties an editing rule to the
     * DOM selection and cannot run headlessly at all.
     */
    consumeEscapeIntoNewline() {
      editor.update(
        () => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;

          const anchor = selection.anchor;
          const node = anchor.getNode();
          if (!$isTextNode(node) || anchor.offset === 0) return;

          const text = node.getTextContent();
          const caret = anchor.offset;
          if (text[caret - 1] !== '\\') return;

          node.setTextContent(text.slice(0, caret - 1) + text.slice(caret));
          node.select(caret - 1, caret - 1);

          const after = $getSelection();
          if ($isRangeSelection(after)) after.insertLineBreak();
        },
        { discrete: true }
      );
    },

    /**
     * Empty the document in a single update.
     *
     * `HistoryPlugin` records it as ONE entry, which is the whole requirement:
     * this clear sits two taps behind a key someone is already hammering to
     * stop a turn that will not stop, and Cmd+Z has to bring the draft back.
     */
    clearThroughUndoStack() {
      editor.update(
        () => {
          const root = $getRoot();
          root.clear();
          root.selectEnd();
        },
        { discrete: true }
      );
    },

    /** The editor's own composition state, which a textarea does not have. */
    isComposing() {
      return editor.isComposing();
    },
  };
}

/**
 * Put a collapsed caret at a markdown offset, outside a Lexical callback.
 *
 * Used by the conformance mount to place the caret a scenario asks for.
 *
 * @param editor - The editor to move the caret in.
 * @param pos - An offset into the document's markdown.
 */
export function selectMarkdownOffset(editor: LexicalEditor, pos: number): void {
  editor.update(
    () => {
      $selectMarkdownOffset($serializeWithOffsets(), pos);
    },
    { discrete: true }
  );
}
