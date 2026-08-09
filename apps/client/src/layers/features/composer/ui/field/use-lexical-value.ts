/**
 * The controlled-value boundary between a Lexical editor and a host that speaks
 * markdown text plus a markdown offset.
 *
 * @module features/composer/ui/field/use-lexical-value
 */
import { useCallback, useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $markdownOffsetOfSelection,
  $parseComposerMarkdown,
  $selectMarkdownOffset,
  $serializeWithOffsets,
  type SerializedComposerDoc,
} from './markdown-offsets';

/**
 * Tag on the update that re-hydrates the document from the host's value.
 *
 * Exported so a test can count hydrations through Lexical's own mechanism
 * rather than by spying on a private function — and used by the listener below
 * to keep the field from echoing its own hydration back to the host.
 */
export const HYDRATE_TAG = 'composer-hydrate';

/** What the value boundary needs from the field around it. */
export interface UseLexicalValueOptions {
  value: string;
  onChange: (value: string) => void;
  /** Caret position, in the same units `value` is measured in. */
  onCursorChange?: (pos: number) => void;
}

/** What the field gets back. */
export interface UseLexicalValueResult {
  /** Focus the editable and put a collapsed caret at markdown offset `pos`. */
  focusAt: (pos: number) => void;
}

/**
 * Keep the document and the host's `value` in step, in both directions.
 *
 * **The emitted-value latch.** The document is re-hydrated from `value` ONLY
 * when `value` differs from the last string this field emitted. In words: we
 * own the document while the person types; the host owns it when the host
 * changes the text out from under us.
 *
 * Dropping that guard is the single most common way a controlled Lexical
 * integration fails, and it fails invisibly to every other test: each keystroke
 * round-trips its own output back through the parser, which rebuilds every
 * node, resets the selection to the start, and empties the undo stack. The
 * suite stays green and the editor feels broken. That is why the latch has its
 * own test and its own mutation check.
 *
 * **The selection-only fast path.** When an update dirties no elements and no
 * leaves, only the selection moved: the cached document is still valid, so
 * serialization is skipped entirely and only `onCursorChange` fires.
 * Serialization runs on every document change on the most latency-sensitive
 * surface in the product, so this path is why the typing budget is reachable.
 *
 * **The emission order is fixed by an existing contract.**
 * `features/mentions/model/use-mention-autocomplete.ts` documents it: text
 * first, then cursor. So a document change emits `onChange(markdown)` and THEN
 * `onCursorChange(offset)`, synchronously, in one listener call. The other
 * order — or two separate effects — makes the room picker match a trigger
 * against a stale string.
 *
 * @param options - The host's value and its change callbacks.
 * @returns The imperative caret move the composer's handle forwards to.
 */
export function useLexicalValue({
  value,
  onChange,
  onCursorChange,
}: UseLexicalValueOptions): UseLexicalValueResult {
  const [editor] = useLexicalComposerContext();

  /** The last markdown this field handed to the host. */
  const lastEmittedRef = useRef<string | null>(null);
  /** The document behind that string, reused by the selection-only path. */
  const lastDocRef = useRef<SerializedComposerDoc | null>(null);

  // Callbacks are read through a ref so the listener registers once. Otherwise
  // a host passing an inline arrow would tear down and re-register on every
  // render, which drops updates that land in the gap. Written in an effect
  // rather than during render — effects settle before anything can type.
  const handlersRef = useRef({ onChange, onCursorChange });
  useEffect(() => {
    handlersRef.current = { onChange, onCursorChange };
  }, [onChange, onCursorChange]);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves, tags }) => {
      // Our own hydration is not news for the host — it is the host's own
      // value coming back.
      if (tags.has(HYDRATE_TAG)) return;

      const { onChange: emitChange, onCursorChange: emitCursor } = handlersRef.current;

      editorState.read(() => {
        const selectionOnly = dirtyElements.size === 0 && dirtyLeaves.size === 0;
        const cached = lastDocRef.current;

        if (selectionOnly && cached !== null) {
          const pos = $markdownOffsetOfSelection(cached);
          if (pos !== null) emitCursor?.(pos);
          return;
        }

        const doc = $serializeWithOffsets();
        lastDocRef.current = doc;
        lastEmittedRef.current = doc.markdown;

        emitChange(doc.markdown);
        const pos = $markdownOffsetOfSelection(doc);
        if (pos !== null) emitCursor?.(pos);
      });
    });
  }, [editor]);

  useEffect(() => {
    if (value === lastEmittedRef.current) return;

    editor.update(
      () => {
        $parseComposerMarkdown(value);
        // Set inside the same update, so the listener this triggers does not
        // see a stale value and hydrate what it just parsed.
        lastEmittedRef.current = value;
        lastDocRef.current = null;
      },
      { tag: HYDRATE_TAG }
    );
  }, [editor, value]);

  const focusAt = useCallback(
    (pos: number) => {
      editor.update(() => {
        $selectMarkdownOffset($serializeWithOffsets(), pos);
      });
      editor.focus();
    },
    [editor]
  );

  return { focusAt };
}
