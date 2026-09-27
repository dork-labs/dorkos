import { describe, expect, it } from 'vitest';
import { oneSentence, trustedLogoUrl } from '../app-presentation.js';

const HOSTS = ['logos.composio.dev'];

describe('trustedLogoUrl', () => {
  it('keeps an https logo on the service’s own host', () => {
    expect(trustedLogoUrl('https://logos.composio.dev/api/gmail', HOSTS)).toBe(
      'https://logos.composio.dev/api/gmail'
    );
    expect(trustedLogoUrl('https://LOGOS.composio.dev/api/gmail', HOSTS)).toBe(
      'https://logos.composio.dev/api/gmail'
    );
  });

  it.each([
    ['plain http', 'http://logos.composio.dev/api/gmail'],
    ['another host', 'https://www.graphhopper.com/logo.png'],
    ['a look-alike host', 'https://logos.composio.dev.evil.test/api/gmail'],
    ['credentials in the URL', 'https://user:pass@logos.composio.dev/api/gmail'],
    ['an explicit port', 'https://logos.composio.dev:8443/api/gmail'],
    ['a data URL', 'data:image/svg+xml;base64,PHN2Zz4='],
    ['not a URL', 'logos.composio.dev/api/gmail'],
    ['empty', ''],
  ])('drops %s', (_label, raw) => {
    expect(trustedLogoUrl(raw, HOSTS)).toBeUndefined();
  });
});

describe('oneSentence', () => {
  it('keeps only the first sentence, whitespace collapsed', () => {
    expect(oneSentence('  Linear tracks  issues.\n It also plans cycles. ')).toBe(
      'Linear tracks issues.'
    );
  });

  it('does not end a sentence inside a name like Node.js or v2.1', () => {
    expect(oneSentence('Vercel hosts Node.js apps on v2.1 runtimes. More text.')).toBe(
      'Vercel hosts Node.js apps on v2.1 runtimes.'
    );
  });

  it('does not end a sentence at a common abbreviation', () => {
    expect(oneSentence('Acme Inc. makes invoices for small shops. It also does taxes.')).toBe(
      'Acme Inc. makes invoices for small shops.'
    );
    expect(
      oneSentence('Connect chat tools, e.g. Slack and Teams, to one inbox. Then reply fast.')
    ).toBe('Connect chat tools, e.g. Slack and Teams, to one inbox.');
    expect(oneSentence('Book time with Dr. Smith and St. Mary clinics online. More.')).toBe(
      'Book time with Dr. Smith and St. Mary clinics online.'
    );
  });

  it('does not stop at a sentence too short to stand alone', () => {
    expect(oneSentence('Meet Zeta. Zeta tracks every package you ship. Learn more.')).toBe(
      'Meet Zeta. Zeta tracks every package you ship.'
    );
  });

  it('keeps a description with no full stop whole', () => {
    expect(oneSentence('Gmail is Google’s email service')).toBe('Gmail is Google’s email service');
  });

  it('cuts a long sentence at a word, within the catalog’s limit', () => {
    const long = `${'word '.repeat(80)}end.`;
    const cut = oneSentence(long)!;
    expect(cut.length).toBeLessThanOrEqual(201);
    expect(cut.endsWith('word…')).toBe(true);
  });

  it('gives nothing for empty text', () => {
    expect(oneSentence('   ')).toBeUndefined();
    expect(oneSentence(undefined)).toBeUndefined();
  });
});
