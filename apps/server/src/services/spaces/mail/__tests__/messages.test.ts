import { describe, expect, it } from 'vitest';
import { plainTextMail, type ComposedMail } from '../messages.js';

describe('plainTextMail', () => {
  it('joins paragraphs with one blank line and ends the body with a newline', () => {
    // Purpose: fails if paragraphs run together, blank ones leave gaps, or Windows line endings
    // survive into the body.
    expect(plainTextMail('  Hello  ', ['First line\r\nsecond', '', '  Third  '])).toEqual({
      subject: 'Hello',
      text: 'First line\nsecond\n\nThird\n',
    });
  });

  it('refuses a subject that could start a new header, or that is empty or too long', () => {
    // Purpose: fails if a line break, another control character, an empty subject, or one
    // longer than 200 characters reaches the mail's Subject header.
    for (const subject of [
      'Hi\r\nBcc: x@evil.test',
      'Hi\nthere',
      'Tab\there',
      '',
      '   ',
      'x'.repeat(201),
    ])
      expect(() => plainTextMail(subject, ['Body']), JSON.stringify(subject)).toThrow(
        'A mail subject must be one line'
      );
    expect(plainTextMail('x'.repeat(200), ['Body']).subject).toHaveLength(200);
  });

  it('drops control characters from the body but keeps its line breaks', () => {
    // Purpose: fails if a bell, an escape sequence, a lone carriage return, or a C1 control
    // character reaches the plain-text body.
    expect(plainTextMail('Subject', ['a\u0007b\u001b[31mc\rd\u0085e']).text).toBe('ab[31mc\nde\n');
  });

  it('refuses a message with no body', () => {
    // Purpose: fails if an empty notice could be sent.
    expect(() => plainTextMail('Subject', ['', '  '])).toThrow('at least one paragraph');
  });

  it('is the only way to make a message a composer can return', () => {
    // Purpose: fails to type-check if a composer could hand the worker text that skipped the
    // bare-CR clean-up, where `\r.\r` could end the SMTP body early.
    // @ts-expect-error A plain object is not a ComposedMail.
    const forged: ComposedMail = { subject: 'Subject', text: 'a\r.\rb' };
    expect(forged.text).toContain('\r');
    expect(plainTextMail('Subject', ['a\r.\rb']).text).toBe('a\n.\nb\n');
  });
});
