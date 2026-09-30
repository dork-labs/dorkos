import { describe, expect, it } from 'vitest';
import { REDACTED, redactor } from '../redact.js';

describe('two-Desktop redaction', () => {
  it('hides each secret as written, URL-encoded and JSON-escaped', () => {
    // Catches a password or invite slipping into a receipt through a different encoding.
    const redact = redactor(['pa"ss word', 'https://c.example/join#invite=tok', 'invite=tok', '']);
    const text = [
      'plain pa"ss word',
      `url ${encodeURIComponent('pa"ss word')}`,
      `json ${JSON.stringify({ p: 'pa"ss word' })}`,
      'link https://c.example/join#invite=tok',
      'token invite=tok',
    ].join('\n');
    const out = redact(text);
    expect(out).not.toMatch(/pa"ss|pa\\"ss|pa%22ss|invite=tok/);
    expect(out.split(REDACTED)).toHaveLength(6);
  });

  it('leaves text alone when there is nothing to hide', () => {
    // A local run passes no secrets; its logs must come through unchanged.
    expect(redactor([])('nothing secret here')).toBe('nothing secret here');
  });
});
