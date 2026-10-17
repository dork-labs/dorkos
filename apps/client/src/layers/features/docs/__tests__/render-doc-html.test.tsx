// @vitest-environment node
/**
 * `renderDocToHtml` in Node, with no DOM at all: the proof that publishing a
 * doc needs no browser and never loads the editor.
 */
import { describe, it, expect, vi } from 'vitest';
import type { EmbedProps, EmbedRegistry } from 'blintz';
import { DOC_EMBED_CATALOG, DOC_EMBED_NAMES } from '@dorkos/shared/doc-embeds';

// The import-graph half of the proof. Each factory throws, so if anything this
// file pulls in imports the editor (Blintz's root entry), Milkdown or
// ProseMirror, this suite fails to load. `blintz/markdown` is a separate entry
// point and stays real.
vi.mock('blintz', () => {
  throw new Error('renderDocToHtml imported the Blintz editor entry');
});
vi.mock('@milkdown/kit', () => {
  throw new Error('renderDocToHtml imported Milkdown');
});
vi.mock('@milkdown/react', () => {
  throw new Error('renderDocToHtml imported Milkdown');
});
vi.mock('prosemirror-view', () => {
  throw new Error('renderDocToHtml imported ProseMirror');
});
vi.mock('prosemirror-state', () => {
  throw new Error('renderDocToHtml imported ProseMirror');
});

import { renderDocToHtml } from '../lib/render-doc-html';

/** A catalog example, written the way agents are told to write it. */
function directive(name: (typeof DOC_EMBED_NAMES)[number]): string {
  const pairs = Object.entries(DOC_EMBED_CATALOG[name].example).map(([key, value]) =>
    value.startsWith('[') ? `${key}='${value}'` : `${key}="${value}"`
  );
  return `::${name}{${pairs.join(' ')}}`;
}

describe('renderDocToHtml', () => {
  it('runs with no window or document', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
  });

  it('renders CommonMark and GFM', async () => {
    const html = await renderDocToHtml(
      '# Plan\n\nSome *text*.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n'
    );
    expect(html).toContain('<h1>Plan</h1>');
    expect(html).toContain('<em>text</em>');
    expect(html).toContain('<table>');
    expect(html).toContain('type="checkbox"');
  });

  it.each(DOC_EMBED_NAMES)('%s: draws the gen-UI component for the node', async (name) => {
    const html = await renderDocToHtml(`Intro\n\n${directive(name)}\n`);
    expect(html).toContain(`data-doc-embed="${name}"`);
    expect(html).not.toContain('data-doc-embed-problem');
    expect(html).toContain('<p>Intro</p>');
  });

  it('draws final states, not a first animation frame', async () => {
    const html = await renderDocToHtml('::stat{label="Revenue" value="$12.4k"}');
    // A count-up captured mid-flight would read "$0".
    expect(html).toContain('$12.4k');
    expect(html).not.toMatch(/opacity:\s*0/);
  });

  it('shows the label as a caption', async () => {
    const html = await renderDocToHtml('::badge[Shipped on Friday]{text="Done"}');
    expect(html).toContain('<figcaption');
    expect(html).toContain('Shipped on Friday');
  });

  it('shows readers a quiet note, not the author’s issues, for an embed that does not validate', async () => {
    const html = await renderDocToHtml(`::chart{kind="bar" data='[{"label":"a","value":-1}]'}`);
    expect(html).toContain('data-doc-embed-unavailable');
    expect(html).toContain('This part of the doc can’t be shown here.');
    expect(html).not.toContain('data.0.value');
    expect(html).not.toContain('Can’t show this chart');
  });

  it('shows the same note for a name with no component', async () => {
    const html = await renderDocToHtml('::callout{text="hi"}');
    expect(html).toContain('data-doc-embed-unavailable');
    expect(html).not.toContain('callout');
  });

  it('keeps an escaped \\::name line as text', async () => {
    const html = await renderDocToHtml('\\::chart{kind="bar"}');
    expect(html).toContain('<p>::chart{kind="bar"}</p>');
  });

  it('lays a container out as the embed, then its own markdown, embeds in it included', async () => {
    const html = await renderDocToHtml(
      ':::badge[Status]{text="Live"}\nIt is **live**.\n\n::progress{value="60"}\n:::\n'
    );
    const badge = html.indexOf('data-doc-embed="badge"');
    const body = html.indexOf('<strong>live</strong>');
    const progress = html.indexOf('data-doc-embed="progress"');
    expect(badge).toBeGreaterThanOrEqual(0);
    expect(body).toBeGreaterThan(badge);
    expect(progress).toBeGreaterThan(body);
    expect(html).toContain('Status');
  });

  it('leaves frontmatter out and keeps a wiki link as its words', async () => {
    const html = await renderDocToHtml('---\ntitle: Secret\n---\n\nSee [[Roadmap|the roadmap]].');
    expect(html).not.toContain('Secret');
    expect(html).toContain('See the roadmap.');
  });

  it('turns a component that throws into the reader’s note, never a failed render', async () => {
    function Broken(_props: EmbedProps): never {
      throw new Error('bad render');
    }
    const embeds: EmbedRegistry = { broken: { component: Broken } };
    const html = await renderDocToHtml('::broken', { embeds });
    expect(html).toContain('data-doc-embed-unavailable');
    expect(html).not.toContain('bad render');
  });

  describe('math', () => {
    it('renders inline and display math as MathML', async () => {
      const html = await renderDocToHtml('Area $\\pi r^2$ here.\n\n$$\nE = mc^2\n$$\n');
      expect(html).toMatch(
        /<p>Area <span class="katex"><math[^>]*>.*<\/math><\/span> here\.<\/p>/s
      );
      expect(html).toContain('display="block"');
      expect(html).toContain('<mi>π</mi>');
    });

    it('draws a latex code block as math, as the editor does', async () => {
      const html = await renderDocToHtml('```latex\nx^2\n```\n');
      expect(html).toContain('<math');
      expect(html).not.toContain('<code');
    });

    it('leaves a mermaid block as code', async () => {
      const html = await renderDocToHtml('```mermaid\ngraph TD; A-->B\n```\n');
      expect(html).toContain('<code class="language-mermaid">');
    });

    it('shows a formula KaTeX cannot read as its source, and never a link', async () => {
      const html = await renderDocToHtml('$\\frac{1$ and $\\href{javascript:alert(1)}{x}$');
      expect(html).toContain('<math');
      expect(html).not.toContain('href=');
    });
  });

  describe('sanitizing', () => {
    it('shows raw HTML as text, never as markup', async () => {
      const html = await renderDocToHtml(
        '<script>alert(1)</script>\n\nHi <img src=x onerror="alert(1)">'
      );
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<img');
      expect(html).toContain('&#x3C;script>');
    });

    it('drops script links', async () => {
      const html = await renderDocToHtml('[click](javascript:alert(1)) ![x](javascript:alert(2))');
      expect(html).not.toContain('javascript:');
    });

    it('escapes what an embed is given', async () => {
      const html = await renderDocToHtml(
        `::table[<img src=x onerror=alert(1)>]{columns='[{"key":"a","label":"<b>A</b>"}]' rows='[{"a":"<script>x</script>"}]'}`
      );
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<img');
      expect(html).not.toContain('<b>A</b>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('cannot be tricked into splicing an embed into markdown it did not draw', async () => {
      const html = await renderDocToHtml(
        '<dorkos-doc-embed-slot data-slot="0"></dorkos-doc-embed-slot>\n\n::badge{text="ok"}'
      );
      // The raw element is text; the one real embed is drawn once.
      expect(html.match(/data-doc-embed="badge"/g)).toHaveLength(1);
      expect(html).toContain('&#x3C;dorkos-doc-embed-slot');
    });
  });
});
