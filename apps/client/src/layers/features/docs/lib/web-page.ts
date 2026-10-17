/**
 * Wrap a rendered doc in a standalone web page: one `.html` file that opens in
 * any browser with no app and no server. Its text, styles, embeds and math are
 * all inside the file. Images are not: an image with a web address loads from
 * that address, and an image named by a path relative to the doc does not
 * resolve once the page is out of the app, so it shows as missing.
 *
 * {@link buildWebPage} is a pure string function. {@link collectPageCss} is the
 * one browser-only step: it copies the stylesheets this tab already has, so the
 * embeds in the saved page look exactly as they do in the app.
 *
 * @module features/docs/lib/web-page
 */

/** What {@link buildWebPage} puts in the page. */
export interface WebPageInput {
  /** The page title, shown on the browser tab. */
  title: string;
  /** The doc as an HTML fragment, from `renderDocToHtml`. */
  bodyHtml: string;
  /** Stylesheet text to inline; the embeds' look comes from here. */
  css: string;
  /** Which color theme the page opens in. */
  theme: 'light' | 'dark';
}

/** Embeds carry their own styling; prose rules skip them. */
const OUTSIDE_EMBEDS = ':not(.dorkos-doc-embed *)';

/** Typography for the doc's own markdown, element by element. */
const PROSE_RULES: readonly (readonly [selector: string, declarations: string])[] = [
  ['h1', 'font-size: 1.875rem; font-weight: 700; margin: 0 0 1rem;'],
  ['h2', 'font-size: 1.375rem; font-weight: 600; margin: 2rem 0 0.75rem;'],
  ['h3', 'font-size: 1.125rem; font-weight: 600; margin: 1.5rem 0 0.5rem;'],
  [':is(h4, h5, h6)', 'font-weight: 600; margin: 1.25rem 0 0.5rem;'],
  [':is(p, ul, ol, blockquote, pre, table)', 'margin: 0 0 1rem;'],
  ['ul', 'list-style: disc; padding-left: 1.5rem;'],
  ['ol', 'list-style: decimal; padding-left: 1.5rem;'],
  ['a', 'color: hsl(var(--status-info-fg, var(--foreground))); text-decoration: underline;'],
  [
    'blockquote',
    'border-left: 3px solid hsl(var(--border)); padding-left: 1rem; color: hsl(var(--muted-foreground));',
  ],
  ['code', 'font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.875em;'],
  [':not(pre) > code', 'background: hsl(var(--muted)); padding: 0.1em 0.3em; border-radius: 4px;'],
  ['pre', 'background: hsl(var(--muted)); padding: 1rem; border-radius: 8px; overflow-x: auto;'],
  ['table', 'border-collapse: collapse; width: 100%;'],
  [
    ':is(th, td)',
    'border: 1px solid hsl(var(--border)); padding: 0.4rem 0.6rem; text-align: left;',
  ],
  ['hr', 'border: 0; border-top: 1px solid hsl(var(--border)); margin: 2rem 0;'],
  ['img', 'max-width: 100%;'],
];

/**
 * The page column and the doc's typography. In the `base` layer, below the
 * app's utility classes, and kept out of embeds, so an embed looks exactly as
 * it does in the app.
 */
const DOC_PAGE_CSS = [
  '@layer base {',
  '.dorkos-doc-page { max-width: 46rem; margin: 0 auto; padding: 3rem 1.5rem; line-height: 1.65; ' +
    'color: hsl(var(--foreground)); font-family: var(--font-sans, system-ui, sans-serif); }',
  ...PROSE_RULES.map(
    ([selector, declarations]) =>
      `.dorkos-doc-page ${selector}${OUTSIDE_EMBEDS} { ${declarations} }`
  ),
  '}',
].join('\n');

/**
 * The app pins `html` and `body` to the window and hides their overflow (it
 * scrolls inside panels). A page has to scroll as a whole. Unlayered, and on
 * a class only this page carries, so it outranks those unlayered app rules.
 */
const PAGE_SCROLL_CSS = `html.dorkos-doc-page-root, html.dorkos-doc-page-root body {
  height: auto; overflow: auto;
}`;

/** Text that is safe inside an HTML element or a double-quoted attribute. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the standalone page.
 *
 * @param input - Title, the doc's HTML, the stylesheet text and the theme.
 * @returns A complete HTML document.
 */
export function buildWebPage({ title, bodyHtml, css, theme }: WebPageInput): string {
  // A stylesheet cannot carry its own closing tag, or the rest would be markup.
  const styles = `${css}\n${DOC_PAGE_CSS}\n${PAGE_SCROLL_CSS}`.replace(/<\/style/gi, '<\\/style');
  return [
    '<!doctype html>',
    `<html lang="en" class="dorkos-doc-page-root${theme === 'dark' ? ' dark' : ''}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="color-scheme" content="${theme}">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>${styles}</style>`,
    '</head>',
    '<body class="bg-background text-foreground">',
    `<main class="dorkos-doc-page">${bodyHtml}</main>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * Every CSS rule this page can read, as text. A stylesheet from another origin
 * refuses to be read and is skipped; the app ships its own styles same-origin,
 * so nothing an embed uses is lost.
 *
 * @param doc - The document whose stylesheets to copy.
 */
export function collectPageCss(doc: Document): string {
  const rules: string[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) rules.push(rule.cssText);
    } catch {
      // A cross-origin stylesheet: its rules are not ours to read.
    }
  }
  return rules.join('\n');
}
