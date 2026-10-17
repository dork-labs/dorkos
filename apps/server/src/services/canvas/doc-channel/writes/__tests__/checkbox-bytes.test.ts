import { describe, expect, it } from 'vitest';
import { prepareCheckboxBytes, rawByteHash } from '../checkbox-bytes.js';

function edit(text: string, line: number, done: boolean) {
  const bytes = Buffer.from(text);
  return prepareCheckboxBytes(bytes, {
    line,
    done,
    expectedFileVersion: rawByteHash(bytes),
    textHash: rawByteHash(Buffer.from(text.split(/\r\n|\n|\r/)[line - 1]!)),
  });
}

describe('parser-proven checkbox raw bytes', () => {
  it('preserves BOM, CRLF, unicode, repeated labels and final newline shape', () => {
    const original = '\ufeff- [ ] café\r\n- [ ] café\r\n';
    const result = edit(original, 2, true);
    expect(result.after.toString()).toBe('\ufeff- [ ] café\r\n- [x] café\r\n');
    expect(result.before.toString()).toBe(original);
    expect(result.afterHash).toBe(rawByteHash(result.after));
    expect(edit('\ufeff- [ ] first', 1, true).after.toString()).toBe('\ufeff- [x] first');
  });
  it('handles ordered, nested and quoted task provenance', () => {
    for (const text of ['1. [ ] ordered', '- parent\n  - [ ] nested', '> - [ ] quoted']) {
      const line = text.includes('\n') ? 2 : 1;
      expect(edit(text, line, true).after.toString()).toBe(text.replace('[ ]', '[x]'));
    }
  });
  it('uses absolute desired state and preserves uppercase X no-op', () => {
    expect(edit('- [X] done', 1, true).changed).toBe(false);
    expect(edit('- [X] done', 1, true).after.toString()).toBe('- [X] done');
    expect(edit('- [x] done', 1, false).after.toString()).toBe('- [ ] done');
  });
  it.each([
    '```md\n- [ ] code\n```',
    '    - [ ] code',
    '---\n- [ ] frontmatter\n---',
    '+++\n- [ ] frontmatter\n+++',
    '---  \n- [ ] unclosed',
    'text - [ ] fake',
    '- \\[ ] escaped',
    '- `[ ]` inline',
  ])('refuses unsupported syntax %s', (text) => {
    const line = text.startsWith('```') || text.startsWith('---') || text.startsWith('+++') ? 2 : 1;
    expect(() => edit(text, line, true)).toThrow();
  });
  it('accepts tasks after masked frontmatter without changing offsets', () => {
    expect(edit('---\r\nx: café\r\n---\r\n- [ ] yes', 4, true).after.toString()).toBe(
      '---\r\nx: café\r\n---\r\n- [x] yes'
    );
  });
  it('refuses stale versions, wrong physical hash, invalid UTF8 and bounds', () => {
    const bytes = Buffer.from('- [ ] yes');
    const request = {
      line: 1,
      done: true,
      expectedFileVersion: rawByteHash(bytes),
      textHash: rawByteHash(bytes),
    };
    expect(() => prepareCheckboxBytes(bytes, { ...request, expectedFileVersion: '0' })).toThrow();
    expect(() => prepareCheckboxBytes(bytes, { ...request, textHash: '0' })).toThrow();
    expect(() => prepareCheckboxBytes(bytes, request, 2)).toThrow();
    const invalid = Buffer.from([0xff]);
    expect(() =>
      prepareCheckboxBytes(invalid, { ...request, expectedFileVersion: rawByteHash(invalid) })
    ).toThrow();
  });
  it.each(['---  ', '---\t', '+++  ', '+++\t'])(
    'never edits metadata under padded frontmatter delimiter %j',
    (delimiter) => {
      const text = `${delimiter}\r\n- [ ] metadata\r\n${delimiter}\r\n- [ ] actual`;
      expect(() => edit(text, 2, true)).toThrow();
      expect(edit(text, 4, true).after.toString()).toBe(
        text.replace('- [ ] actual', '- [x] actual')
      );
    }
  );
});
