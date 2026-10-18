/**
 * @vitest-environment jsdom
 *
 * The Docs embed registry inside the REAL Blintz editor: the directive is read
 * by Blintz's grammar, validated by our validator, and drawn by the gen-UI
 * component, exactly as a doc in the canvas is.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MarkdownEditor, validateEmbedAttributes } from 'blintz';
import { DOC_EMBED_CATALOG, DOC_EMBED_NAMES } from '@dorkos/shared/doc-embeds';
import { DOC_EMBEDS, DOC_EMBEDS_FOR_READERS } from '../ui/doc-embed-registry';

afterEach(cleanup);

/** A catalog example, written the way agents are told to write it. */
function directive(name: (typeof DOC_EMBED_NAMES)[number]): string {
  const pairs = Object.entries(DOC_EMBED_CATALOG[name].example).map(([key, value]) =>
    value.startsWith('[') ? `${key}='${value}'` : `${key}="${value}"`
  );
  return `::${name}{${pairs.join(' ')}}`;
}

/** Mount the real editor and wait for the embed frame Blintz draws for `name`. */
async function mountEmbed(
  markdown: string,
  name: string,
  embeds = DOC_EMBEDS
): Promise<HTMLElement> {
  render(<MarkdownEditor value={markdown} editable={false} embeds={embeds} />);
  let frame: HTMLElement | null = null;
  await waitFor(
    () => {
      frame = document.querySelector<HTMLElement>(`[data-embed-name="${name}"]`);
      expect(frame).not.toBeNull();
    },
    { timeout: 4000 }
  );
  return frame!;
}

describe('DOC_EMBEDS in the real editor', () => {
  it.each(DOC_EMBED_NAMES)('%s: draws the gen-UI node for its slash-menu starter', async (name) => {
    const frame = await mountEmbed(`${directive(name)}\n`, name);
    expect(frame).toHaveAttribute('data-embed-state', 'ready');
    expect(frame.querySelector(`[data-doc-embed="${name}"]`)).not.toBeNull();
  });

  it('draws a chart as the same chart a dorkos-ui fence draws', async () => {
    const frame = await mountEmbed(
      `::chart{kind="line" data='[{"label":"Q1","value":3},{"label":"Q2","value":5}]'}\n`,
      'chart'
    );
    expect(frame.querySelector('[role="img"][aria-label="line chart"]')).not.toBeNull();
  });

  it('shows our issues in Blintz’s notice instead of drawing an invalid embed', async () => {
    const frame = await mountEmbed(
      `::chart{kind="bar" data='[{"label":"a","value":-1}]'}\n`,
      'chart'
    );
    expect(frame).toHaveAttribute('data-embed-state', 'invalid');
    expect(frame).toHaveTextContent('data.0.value');
    expect(frame.querySelector('[data-doc-embed]')).toBeNull();
  });

  it('shows a reader one quiet line, without the author’s issues', async () => {
    const frame = await mountEmbed(
      `::chart{kind="bar" data='[{"label":"a","value":-1}]'}\n`,
      'chart',
      DOC_EMBEDS_FOR_READERS
    );
    expect(frame).toHaveTextContent('This chart couldn’t be drawn.');
    expect(frame).not.toHaveTextContent('data.0.value');
    expect(frame).not.toHaveTextContent('kind=');
  });

  it('leaves a name outside the catalog to Blintz’s placeholder', async () => {
    const frame = await mountEmbed('::note{text="hi"}\n', 'note');
    expect(frame).toHaveAttribute('data-embed-state', 'unknown');
  });
});

describe('DOC_EMBEDS slash-menu entries', () => {
  it.each(DOC_EMBED_NAMES)('%s: has a title, an SVG icon and a valid starter', async (name) => {
    const definition = DOC_EMBEDS[name]!;
    expect(definition.title).toBe(DOC_EMBED_CATALOG[name].title);
    expect(definition.icon).toMatch(/^<svg [^>]*viewBox="0 0 24 24"/);
    expect(definition.kind).toBe('leaf');
    const result = await validateEmbedAttributes(definition.validate, {
      ...definition.defaultAttributes,
    });
    expect(result.issues).toBeUndefined();
  });

  it('offers exactly the catalog', () => {
    expect(Object.keys(DOC_EMBEDS)).toEqual([...DOC_EMBED_NAMES]);
  });
});
