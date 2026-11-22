/**
 * The spacing a file cap ignores (DOR-5060, Security's ruling of Nov 22): only
 * what a formatter changes, and nothing a person or a model reads differently.
 */
import { describe, expect, it } from 'vitest';
import { normalizedBody, normalizedBodyHash } from '../file-cap/file-hash.js';

describe('normalizedBody', () => {
  it.each([
    ['CRLF line ends', 'a\r\nb', 'a\nb'],
    ['trailing spaces and tabs', 'a \t\nb  ', 'a\nb'],
    ['runs of blank lines', 'a\n\n\n\nb', 'a\n\nb'],
    ['blank lines of only spaces', 'a\n  \n\t\nb', 'a\n\nb'],
  ])('takes out %s', (_what, body, want) => {
    expect(normalizedBody(body)).toBe(want);
  });

  it.each([
    ['a zero-width space', 'a\u200bb', 'ab'],
    ['a no-break space', 'a\u00a0b', 'a b'],
    ['a leading no-break space', '\u00a0a', ' a'],
    ['an ideographic space', 'a\u3000b', 'a b'],
    ['a bidi override', 'a\u202eb', 'ab'],
    ['a leading space', ' ab', 'ab'],
    ['a leading tab', '\tab', 'ab'],
    ['a lone carriage return', 'a\rb', 'a\nb'],
    ['a first blank line', 'a\n\nb', 'a\nb'],
  ])('keeps %s', (_what, body, plain) => {
    expect(normalizedBody(body)).not.toBe(normalizedBody(plain));
  });

  it('never closes a fence on a line with an info string, or on the other mark', () => {
    const body = '```\n```python\n\n\nx\n~~~\n\n\ny\n```\n\n\nafter';
    expect(normalizedBody(body)).toBe('```\n```python\n\n\nx\n~~~\n\n\ny\n```\n\nafter');
  });

  it('keeps every blank line of a fence that never closes', () => {
    expect(normalizedBody('a\n\n\n```\nb\n\n\nc')).toBe('a\n\n```\nb\n\n\nc');
  });

  it('keeps a fenced block’s indentation and blank lines, trimming only its line ends', () => {
    const body = 'intro\n```py\n  if x:\n\n\n      y()   \n```\n\n\nafter';
    expect(normalizedBody(body)).toBe('intro\n```py\n  if x:\n\n\n      y()\n```\n\nafter');
  });

  it('closes a fence only on the same mark at least as long', () => {
    const body = '````\n```\n\n\ninside\n````\n\n\noutside';
    expect(normalizedBody(body)).toBe('````\n```\n\n\ninside\n````\n\noutside');
  });

  it('hashes a Prettier pass the same, and a changed word differently', () => {
    const written = 'Sweep the backlog.\n- first\nstill the first';
    const formatted = 'Sweep the backlog.  \r\n- first\n\n\nstill the first';
    const written2 = 'Sweep the backlog.\n- first\n\nstill the first';
    expect(normalizedBodyHash(formatted)).toBe(normalizedBodyHash(written2));
    // A re-indented line is a change: it can move a list item into a nested list.
    expect(normalizedBodyHash('- one\n  - two')).not.toBe(normalizedBodyHash('- one\n- two'));
    // A first blank line is a change: it turns a heading into a rule.
    expect(normalizedBodyHash('Title\n\n---')).not.toBe(normalizedBodyHash('Title\n---'));
    expect(normalizedBodyHash('Sweep the backlog.\n- first\n  still the first')).not.toBe(
      normalizedBodyHash(written)
    );
    expect(normalizedBodyHash('Sweep the whole backlog.\n- first\nstill the first')).not.toBe(
      normalizedBodyHash(written)
    );
  });
});
