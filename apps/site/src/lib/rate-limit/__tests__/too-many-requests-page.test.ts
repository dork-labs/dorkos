import { describe, expect, it } from 'vitest';

import {
  escapeHtml,
  tooManyRequestsHtml,
  tooManyRequestsPage,
  waitPhrase,
} from '../too-many-requests-page';

describe('tooManyRequestsPage', () => {
  it('is a 429 carrying the Retry-After it was given', () => {
    const res = tooManyRequestsPage('One moment', 'Try again shortly.', 600);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('600');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('is never cached', () => {
    // The one header on this page that has teeth. These URLs are opened from
    // email, and a 429 cached by a browser, a proxy or a mail gateway outlives
    // the window that produced it: the reader waits out the ten minutes, opens
    // the link again, and is served the same stale refusal forever.
    const res = tooManyRequestsPage('One moment', 'Try again shortly.', 600);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps the page out of search results', () => {
    // A throttle page carries a token-bearing URL and says nothing useful to a
    // stranger. It should never be indexed.
    expect(tooManyRequestsHtml('One moment', 'Try again shortly.')).toContain(
      '<meta name="robots" content="noindex">'
    );
  });
});

describe('escapeHtml', () => {
  it('escapes the characters that could break out of the markup', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes the ampersand first, so an escape is never double-encoded', () => {
    // Replacing `<` before `&` would turn `&lt;` into `&amp;lt;` on the next
    // pass. Order matters, so it is pinned.
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves ordinary prose alone', () => {
    const prose = 'Too many people opened this link from your network just now.';
    expect(escapeHtml(prose)).toBe(prose);
  });

  it('is actually applied to what the page renders', () => {
    const html = tooManyRequestsHtml('<b>Heading</b>', '<img src=x onerror=1>');
    expect(html).toContain('&lt;b&gt;Heading&lt;/b&gt;');
    expect(html).toContain('&lt;img src=x onerror=1&gt;');
    expect(html).not.toContain('<b>Heading</b>');
    expect(html).not.toContain('<img src=x');
  });
});

describe('waitPhrase', () => {
  it('reports the real window rather than a comforting guess', () => {
    // 600 seconds is ten minutes. Saying "a minute" beside a Retry-After of
    // 600 would cost a reader nine minutes of retrying.
    expect(waitPhrase(600)).toBe('about 10 minutes');
  });

  it('rounds up, so a reader is never sent back too early', () => {
    expect(waitPhrase(61)).toBe('about 2 minutes');
    expect(waitPhrase(90)).toBe('about 2 minutes');
  });

  it('never says less than a minute', () => {
    expect(waitPhrase(1)).toBe('about a minute');
    expect(waitPhrase(0)).toBe('about a minute');
  });
});
