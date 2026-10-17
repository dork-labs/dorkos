/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { buildWebPage, collectPageCss } from '../lib/web-page';

describe('buildWebPage', () => {
  const page = (overrides: Partial<Parameters<typeof buildWebPage>[0]> = {}) =>
    buildWebPage({
      title: 'Plan',
      bodyHtml: '<h1>Plan</h1>',
      css: '',
      theme: 'light',
      ...overrides,
    });

  it('is a complete document with the doc in its main region', () => {
    const html = page();
    expect(html).toMatch(/^<!doctype html>\n<html lang="en" class="dorkos-doc-page-root">/);
    expect(html).toContain('<main class="dorkos-doc-page"><h1>Plan</h1></main>');
  });

  it('scrolls as a page, over the app rule that pins html and body to the window', () => {
    expect(page()).toMatch(/html\.dorkos-doc-page-root body \{\s*height: auto; overflow: auto;/);
  });

  it('styles the doc’s markdown but leaves embeds as the app draws them', () => {
    expect(page()).toContain(
      '.dorkos-doc-page ul:not(.dorkos-doc-embed *, [data-doc-embed-problem] *)'
    );
  });

  it('escapes the title', () => {
    expect(page({ title: '<script>"x"' })).toContain('<title>&lt;script&gt;&quot;x&quot;</title>');
  });

  it('opens in the theme it was saved in', () => {
    expect(page({ theme: 'dark' })).toContain('<html lang="en" class="dorkos-doc-page-root dark">');
    expect(page({ theme: 'dark' })).toContain('<meta name="color-scheme" content="dark">');
  });

  it('keeps a stylesheet from closing its own tag', () => {
    const html = page({ css: 'a{}</style><script>alert(1)</script>' });
    expect(html).not.toContain('</style><script>');
  });
});

describe('collectPageCss', () => {
  it('copies the rules the page has', () => {
    const style = document.createElement('style');
    style.textContent = '.probe-rule { color: red; }';
    document.head.appendChild(style);
    expect(collectPageCss(document)).toContain('.probe-rule');
    style.remove();
  });
});
