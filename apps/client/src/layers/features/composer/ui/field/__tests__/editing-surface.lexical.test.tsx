// @vitest-environment jsdom
import {
  $getSelection,
  $isRangeSelection,
  $setCompositionKey,
  createEditor,
  type LexicalEditor,
} from 'lexical';
import {
  runLadderConformance,
  type MountedSurface,
} from '../../../__tests__/editing-surface-conformance';
import { COMPOSER_NODES } from '../lexical-nodes';
import { createLexicalSurface, selectMarkdownOffset } from '../lexical-surface';
import { $parseComposerMarkdown, $serializeWithOffsets } from '../markdown-offsets';

/**
 * A real Lexical editor bound to a real element, driven headlessly.
 *
 * FSD note: the conformance module lives in `features/composer/__tests__/` and
 * this file in `features/composer/ui/field/__tests__/` — both inside the same
 * slice, so a relative import is correct and no barrel widens.
 */
async function mountLexicalSurface(): Promise<MountedSurface> {
  const container = document.createElement('div');
  container.contentEditable = 'true';
  document.body.appendChild(container);

  const editor: LexicalEditor = createEditor({
    namespace: 'composer',
    nodes: COMPOSER_NODES,
    onError: (error) => {
      throw error;
    },
  });
  editor.setRootElement(container);

  return {
    surface: createLexicalSurface(editor),

    setContent(text, caret, anchor) {
      editor.update(
        () => {
          $parseComposerMarkdown(text);
        },
        { discrete: true }
      );

      const start = anchor === undefined ? caret : Math.min(caret, anchor);
      const end = anchor === undefined ? caret : Math.max(caret, anchor);

      // A RANGE is built by capturing the collapsed point at `end` and then
      // pointing the focus at it. `selection.modify` would be the obvious way
      // and is the wrong one: it delegates to the browser's native
      // `Selection.modify`, which jsdom does not implement at all.
      let focusPoint: { key: string; offset: number; type: 'text' | 'element' } | null = null;
      if (end > start) {
        selectMarkdownOffset(editor, end);
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            focusPoint = {
              key: selection.focus.key,
              offset: selection.focus.offset,
              type: selection.focus.type,
            };
          }
        });
      }

      selectMarkdownOffset(editor, start);

      if (focusPoint !== null) {
        const point = focusPoint as { key: string; offset: number; type: 'text' | 'element' };
        editor.update(
          () => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              selection.focus.set(point.key, point.offset, point.type);
            }
          },
          { discrete: true }
        );
      }
    },

    getText() {
      let markdown = '';
      editor.getEditorState().read(() => {
        markdown = $serializeWithOffsets().markdown;
      });
      return markdown;
    },

    // Unlike a textarea, an editor HAS composition state, so the conformance
    // runner drives the real rung here instead of asserting a constant.
    setComposing(composing) {
      editor.update(
        () => {
          if (!composing) {
            $setCompositionKey(null);
            return;
          }
          const selection = $getSelection();
          $setCompositionKey($isRangeSelection(selection) ? selection.anchor.key : null);
        },
        { discrete: true }
      );
    },

    cleanup() {
      editor.setRootElement(null);
      container.remove();
    },
  };
}

runLadderConformance('lexical', mountLexicalSurface);
