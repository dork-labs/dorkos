import { describe, it, expect } from 'vitest';
import { splicePreviewPath } from '../browser-url';

/**
 * The server mints a bootstrap URL for the preview origin's ROOT, because the
 * token is what it is answering about. Someone who opened a deep route has to
 * land on that route, not the app's front door — so the path is spliced in and
 * the token rides along behind it.
 */
describe('splicePreviewPath', () => {
  const BOOTSTRAP = 'http://machine.local:4390/?__dorkos_preview=tok.sig';

  it('puts the logical path on the preview origin, keeping the token', () => {
    const spliced = splicePreviewPath(BOOTSTRAP, '/projects/promo/edit');
    const url = new URL(spliced as string);
    expect(url.origin).toBe('http://machine.local:4390');
    expect(url.pathname).toBe('/projects/promo/edit');
    expect(url.searchParams.get('__dorkos_preview')).toBe('tok.sig');
  });

  it('keeps the page’s own query beside the token', () => {
    const url = new URL(splicePreviewPath(BOOTSTRAP, '/search?q=hello&page=2') as string);
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('q')).toBe('hello');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('__dorkos_preview')).toBe('tok.sig');
  });

  it('treats an empty path as the root', () => {
    expect(new URL(splicePreviewPath(BOOTSTRAP, '') as string).pathname).toBe('/');
  });

  it('never lets the logical path change the origin', () => {
    // A target path is a path; if it ever arrived looking like an absolute URL,
    // framing it would leave the preview origin entirely.
    const url = new URL(splicePreviewPath(BOOTSTRAP, '//evil.example.com/x') as string);
    expect(url.origin).toBe('http://machine.local:4390');
  });

  it('gives up rather than guessing when the minted URL is unusable', () => {
    expect(splicePreviewPath('not a url', '/x')).toBeNull();
  });
});
