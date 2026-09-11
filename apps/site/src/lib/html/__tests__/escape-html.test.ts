import { describe, expect, it } from 'vitest';

import { escapeHtml } from '../escape-html';

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

  it('neutralizes an anchor tag, so injected markup cannot become a link', () => {
    // The email case: a reporter's own words are quoted back to them, and a
    // fake "re-verify your account" link would otherwise arrive as real
    // markup from our own signed sender.
    expect(escapeHtml('<a href="https://evil.test">Verify now</a>')).toBe(
      '&lt;a href="https://evil.test"&gt;Verify now&lt;/a&gt;'
    );
  });

  it('leaves quotes alone — text content only, never an attribute value', () => {
    // Pins the documented limit of this function rather than implying more
    // safety than it offers. See its TSDoc.
    expect(escapeHtml('say "hi"')).toBe('say "hi"');
  });
});
