// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { $convertFromMarkdownString } from '@lexical/markdown';
import { $getRoot, createEditor, type LexicalEditor, type LexicalNode } from 'lexical';
import { COMPOSER_NODES } from '../lexical-nodes';
import {
  COMPOSER_TEXT_FORMAT_SHORTCUTS,
  COMPOSER_TRANSFORMER_COUNT,
  COMPOSER_TRANSFORMERS,
} from '../lexical-transformers';

/** A headless editor with the composer's node set registered. */
function makeEditor(): LexicalEditor {
  return createEditor({
    namespace: 'composer-test',
    nodes: COMPOSER_NODES,
    onError: (error) => {
      throw error;
    },
  });
}

/** What parsing `md` with the composer's transformers produces. */
function parse(md: string): { types: Set<string>; text: string; formats: Set<number> } {
  const editor = makeEditor();
  const types = new Set<string>();
  const formats = new Set<number>();
  let text = '';

  editor.update(
    () => {
      $convertFromMarkdownString(md, [...COMPOSER_TRANSFORMERS]);
      const root = $getRoot();
      text = root.getTextContent();
      const walk = (node: LexicalNode) => {
        types.add(node.getType());
        if (node.getType() === 'text') {
          formats.add((node as unknown as { getFormat(): number }).getFormat());
        }
        const children = (node as unknown as { getChildren?: () => LexicalNode[] }).getChildren?.();
        for (const child of children ?? []) walk(child);
      };
      walk(root);
    },
    { discrete: true }
  );

  return { types, text, formats };
}

/** Lexical's text-format bitmask values, named so the assertions read. */
const FORMAT = { none: 0, bold: 1, italic: 2, code: 16 } as const;

describe('COMPOSER_TRANSFORMERS — what the editor recognizes', () => {
  it.each([
    ['**bold**', 'bold', FORMAT.bold],
    ['__bold__', 'bold', FORMAT.bold],
    ['*italic*', 'italic', FORMAT.italic],
    ['_italic_', 'italic', FORMAT.italic],
    ['`code`', 'code', FORMAT.code],
  ])('%s applies the %s text format', (md, _name, expected) => {
    const { formats } = parse(md);
    expect(formats.has(expected)).toBe(true);
  });

  it.each([
    ['# h1', 'h1'],
    ['## h2', 'h2'],
    ['### h3', 'h3'],
  ])('%s becomes a heading node (%s)', (md) => {
    expect(parse(md).types.has('heading')).toBe(true);
  });

  // The stock HEADING transformer matches `#{1,6}`; the composer stops at three.
  it('#### stays literal text — headings stop at three levels', () => {
    const { types, text } = parse('#### h4');
    expect(types.has('heading')).toBe(false);
    expect(text).toContain('#### h4');
  });

  it.each([['- a'], ['* a'], ['+ a'], ['1. a']])('%s becomes a list', (md) => {
    const { types } = parse(md);
    expect(types.has('list')).toBe(true);
    expect(types.has('listitem')).toBe(true);
  });

  // `1.` without a following space is not a marker — a common false positive.
  it('a line that starts with 1. but is not a list stays text', () => {
    const { types, text } = parse('1.5x faster');
    expect(types.has('list')).toBe(false);
    expect(text).toBe('1.5x faster');
  });
});

describe('COMPOSER_TRANSFORMERS — what stays literal', () => {
  // Every one of the seven exclusions, table-driven, so ADDING a transformer
  // without updating this list turns the suite red. The assertion is not "no
  // node of the excluded class exists" — those classes are unregistered, so
  // that check could never fail. It is the stronger pair: the tree holds
  // nothing but paragraphs and text, no text carries a format, and the source
  // characters are all still there.
  it.each([
    ['blockquote', '> quote'],
    ['fenced code block', '```\ncode\n```'],
    ['link', '[text](url)'],
    ['strikethrough', '~~strike~~'],
    ['horizontal rule', '---'],
    ['table', '| a | b |\n| --- | --- |'],
    ['image', '![alt](src)'],
  ])('%s survives as literal characters', (_name, md) => {
    const { types, text, formats } = parse(md);

    const PLAIN = ['root', 'paragraph', 'text', 'linebreak'];
    expect([...types].filter((type) => !PLAIN.includes(type))).toEqual([]);
    expect([...formats].filter((format) => format !== FORMAT.none)).toEqual([]);
    for (const line of md.split('\n')) expect(text).toContain(line);
  });
});

describe('COMPOSER_TRANSFORMERS — the closed set itself', () => {
  // Count as well as behaviour: an accidental `...TRANSFORMERS` spread would
  // keep every named row working and still be caught here.
  it('holds exactly the transformers it names', () => {
    expect(COMPOSER_TRANSFORMERS).toHaveLength(COMPOSER_TRANSFORMER_COUNT);
  });

  it('offers two keyboard formats and no ⌘K, because there are no links', () => {
    expect(COMPOSER_TEXT_FORMAT_SHORTCUTS.map((s) => s.key)).toEqual(['b', 'i']);
    expect(COMPOSER_TEXT_FORMAT_SHORTCUTS.map((s) => s.format)).toEqual(['bold', 'italic']);
  });
});
