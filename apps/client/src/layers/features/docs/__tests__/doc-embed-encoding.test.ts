// @vitest-environment node
/**
 * The string-attribute encoding the Docs embed catalog relies on, proven
 * through Blintz's own grammar (`blintz/markdown`) and remark-stringify — the
 * same parse and write the editor does — rather than assumed.
 */
import { describe, it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import type { Root } from 'mdast';
import { remarkBlockDirectives } from 'blintz/markdown';
import { DOC_EMBED_CATALOG, DOC_EMBED_NAMES, decodeDocEmbed } from '@dorkos/shared/doc-embeds';

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkBlockDirectives)
  .use(remarkStringify);

interface Directive {
  type: string;
  name?: string;
  attributes?: Record<string, string>;
}

/** The first block of a parsed doc. */
function firstBlock(markdown: string): Directive {
  return (processor.parse(markdown) as Root).children[0] as unknown as Directive;
}

/** Parse then write back, as an editor save does. */
function rewrite(markdown: string): string {
  return processor.stringify(processor.parse(markdown) as Root);
}

/** A directive the way agents are told to write one: JSON single-quoted. */
function authored(name: string, attributes: Record<string, string>): string {
  const pairs = Object.entries(attributes).map(([key, value]) =>
    value.trimStart().startsWith('[') || value.trimStart().startsWith('{')
      ? `${key}='${value}'`
      : `${key}="${value}"`
  );
  return `::${name}{${pairs.join(' ')}}`;
}

describe('Docs embed attributes through the Blintz grammar', () => {
  it.each(DOC_EMBED_NAMES)(
    '%s: the authored form parses, survives a rewrite, and still decodes',
    (name) => {
      const example = { ...DOC_EMBED_CATALOG[name].example };
      const source = authored(name, example);
      const parsed = firstBlock(source);
      expect(parsed).toMatchObject({ type: 'leafDirective', name, attributes: example });

      const written = rewrite(source);
      expect(firstBlock(written).attributes).toEqual(example);
      // A second save changes nothing: the written form is the fixed point.
      expect(rewrite(written)).toBe(written);
      expect(decodeDocEmbed(name, firstBlock(written).attributes ?? {}).ok).toBe(true);
    }
  );

  it('writes JSON back double-quoted with each " as &#x22;, which decodes to the same string', () => {
    const written = rewrite(`::chart{kind="bar" data='[{"label":"Q1","value":3}]'}`);
    expect(written.trim()).toBe(
      '::chart{kind="bar" data="[{&#x22;label&#x22;:&#x22;Q1&#x22;,&#x22;value&#x22;:3}]"}'
    );
    expect(firstBlock(written).attributes?.data).toBe('[{"label":"Q1","value":3}]');
  });

  it('keeps braces, escaped quotes and \\u0027 inside a JSON value', () => {
    const data = '[{"label":"a}b \\"q\\" it\\u0027s","value":1}]';
    const source = `::chart{kind="bar" data='${data}'}`;
    expect(firstBlock(source).attributes?.data).toBe(data);
    const written = rewrite(source);
    expect(firstBlock(written).attributes?.data).toBe(data);
    const result = decodeDocEmbed('chart', firstBlock(written).attributes ?? {});
    expect(result.ok && result.node.type === 'chart' && result.node.data[0]?.label).toBe(
      `a}b "q" it's`
    );
  });

  it('round-trips attributes an editor insert sets programmatically', () => {
    const attributes = { ...DOC_EMBED_CATALOG.table.example };
    const tree = {
      type: 'root',
      children: [{ type: 'leafDirective', name: 'table', attributes, children: [] }],
    } as unknown as Root;
    const written = processor.stringify(tree);
    expect(firstBlock(written).attributes).toEqual(attributes);
  });

  it('a JSON value broken across lines is not an embed: the line stays text', () => {
    const block = firstBlock(`::chart{kind="bar" data='[{"label":"Q1",\n"value":3}]'}`);
    expect(block.type).toBe('paragraph');
  });

  it('a bare single quote inside a single-quoted value is not an embed', () => {
    // Why the guidance says to write it as \u0027 in the JSON instead.
    expect(firstBlock(`::table{rows='[{"a":"it's"}]'}`).type).toBe('paragraph');
  });

  it('an escaped \\::name line stays text through a rewrite', () => {
    const written = rewrite('\\::chart{kind="bar"}');
    expect(firstBlock(written).type).toBe('paragraph');
    expect(written.trim()).toBe('\\::chart{kind="bar"}');
  });
});
