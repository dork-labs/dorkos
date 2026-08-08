// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { $convertFromMarkdownString } from '@lexical/markdown';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $setSelection,
  createEditor,
  type LexicalEditor,
} from 'lexical';
import { $createMentionNode, COMPOSER_NODES } from '../lexical-nodes';
import { COMPOSER_TRANSFORMERS } from '../lexical-transformers';
import {
  $markdownOffsetOfSelection,
  $selectMarkdownOffset,
  $serializeWithOffsets,
} from '../markdown-offsets';

/** A headless editor with the composer's node set. */
function makeEditor(): LexicalEditor {
  return createEditor({
    namespace: 'composer-test',
    nodes: COMPOSER_NODES,
    onError: (error) => {
      throw error;
    },
  });
}

/** Parse `md` into a fresh editor. */
function editorWith(md: string): LexicalEditor {
  const editor = makeEditor();
  editor.update(
    () => {
      $convertFromMarkdownString(md, [...COMPOSER_TRANSFORMERS]);
    },
    { discrete: true }
  );
  return editor;
}

/**
 * Put the caret at the end of the nth text node and report the markdown offset.
 *
 * The three pinned cases below all place the caret somewhere a naive
 * `textContent` walk gets wrong, so each assertion carries the number that walk
 * would have produced.
 */
function offsetAtEndOfTextNode(editor: LexicalEditor, index: number): number | null {
  let offset: number | null = null;
  editor.update(
    () => {
      const node = $getRoot().getAllTextNodes()[index];
      node.select(node.getTextContentSize(), node.getTextContentSize());
      offset = $markdownOffsetOfSelection($serializeWithOffsets());
    },
    { discrete: true }
  );
  return offset;
}

describe('$markdownOffsetOfSelection', () => {
  // A caret immediately after a mention pill must land past the whole
  // `@handle`, not inside it — and past the list marker the person never typed.
  it('puts a caret after a mention pill past the whole handle and the list marker', () => {
    const editor = makeEditor();
    let markdown = '';
    let offset: number | null = null;

    editor.update(
      () => {
        $convertFromMarkdownString('- hi ', [...COMPOSER_TRANSFORMERS]);
        const list = $getRoot().getFirstChild();
        const item = $isElementNode(list) ? list.getFirstChild() : null;
        const mention = $createMentionNode('ana', 'agent', '#7c5cff');
        if ($isElementNode(item)) item.append(mention);
        mention.select(mention.getTextContentSize(), mention.getTextContentSize());
        const doc = $serializeWithOffsets();
        markdown = doc.markdown;
        offset = $markdownOffsetOfSelection(doc);
      },
      { discrete: true }
    );

    expect(markdown).toBe('- hi @ana');
    // 9 = '- hi @ana'.length. A textContent walk would say 7 ('hi @ana').
    expect(offset).toBe(9);
    expect(markdown.slice(0, offset!)).toBe('- hi @ana');
  });

  // The four characters of `**` … `**` belong to no text node at all.
  it('counts the syntax characters a bold run adds', () => {
    const editor = editorWith('**bold** x');
    const offset = offsetAtEndOfTextNode(editor, 0);
    // 6 = index just past 'bold' in '**bold** x'. A textContent walk says 4.
    expect(offset).toBe(6);
  });

  it('counts a list marker, which is serialized but was never typed', () => {
    const editor = editorWith('- item');
    const offset = offsetAtEndOfTextNode(editor, 0);
    // 6 = '- item'.length. A textContent walk says 4.
    expect(offset).toBe(6);
  });

  it('is null for a range selection — there is no single caret to report', () => {
    const editor = editorWith('hello');
    let offset: number | null = -1;
    editor.update(
      () => {
        const node = $getRoot().getAllTextNodes()[0];
        node.select(0, 3);
        offset = $markdownOffsetOfSelection($serializeWithOffsets());
      },
      { discrete: true }
    );
    expect(offset).toBeNull();
  });

  it('is null when nothing is selected at all', () => {
    const editor = editorWith('hello');
    let offset: number | null = -1;
    editor.update(
      () => {
        $setSelection(null);
        offset = $markdownOffsetOfSelection($serializeWithOffsets());
      },
      { discrete: true }
    );
    expect(offset).toBeNull();
  });
});

describe('$selectMarkdownOffset', () => {
  it.each([
    ['plain text', 'hello', 3],
    ['past a list marker', '- item', 4],
    ['inside a bold run', '**bold** x', 4],
    ['after a bold run', '**bold** x', 9],
    ['a heading', '## title', 5],
  ])('is the inverse of the offset it was given (%s)', (_label, md, pos) => {
    const editor = editorWith(md);
    let readBack: number | null = null;

    editor.update(
      () => {
        const doc = $serializeWithOffsets();
        $selectMarkdownOffset(doc, pos);
        readBack = $markdownOffsetOfSelection(doc);
      },
      { discrete: true }
    );

    expect(readBack).toBe(pos);
  });

  it('lands a caret on the far side of a mention, where insertMention leaves it', () => {
    const editor = makeEditor();
    let readBack: number | null = null;

    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('hi '),
              $createMentionNode('ana', 'human'),
              $createTextNode(' ')
            )
          );
        const doc = $serializeWithOffsets();
        expect(doc.markdown).toBe('hi @ana ');
        $selectMarkdownOffset(doc, 8);
        readBack = $markdownOffsetOfSelection(doc);
      },
      { discrete: true }
    );

    expect(readBack).toBe(8);
  });
});
