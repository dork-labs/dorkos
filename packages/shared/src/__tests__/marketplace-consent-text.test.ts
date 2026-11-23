/**
 * Tests for the helpers every marketplace consent surface uses to show a
 * package's commands exactly as they will run (DOR-2195).
 */
import { describe, expect, it } from 'vitest';
import {
  describeHookEvent,
  describeProgramLine,
  revealHiddenCharacters,
  splitHiddenCharacters,
} from '../marketplace-schemas.js';

describe('revealHiddenCharacters', () => {
  it('shows direction-changing and zero-width characters as visible markers', () => {
    // Purpose: U+202E can make `echo ‮gnp.exe` read as something else, and
    // a zero-width space hides inside a word. A person must see both.
    expect(revealHiddenCharacters('a‮b​c⁦d﻿')).toBe('a<U+202E>b<U+200B>c<U+2066>d<U+FEFF>');
  });

  it.each([
    // A tag character is invisible to a person and read as text by a model (DOR-5060).
    ['a tag character', 0xe0041, '<U+E0041>'],
    ['the first tag character', 0xe0000, '<U+E0000>'],
    ['the last tag character', 0xe007f, '<U+E007F>'],
    ['a variation selector', 0xfe0f, '<U+FE0F>'],
    ['a supplementary variation selector', 0xe0100, '<U+E0100>'],
    ['a soft hyphen', 0x00ad, '<U+00AD>'],
    ['a line separator', 0x2028, '<U+2028>'],
    ['a paragraph separator', 0x2029, '<U+2029>'],
  ])('shows %s as a visible marker', (_what, codePoint, marker) => {
    const hidden = String.fromCodePoint(codePoint);
    expect(revealHiddenCharacters(`run${hidden}this`)).toBe(`run${marker}this`);
  });

  it('marks a whole run of tag characters, one marker each, so a hidden sentence shows', () => {
    const tags = [...'rm'].map((ch) => String.fromCodePoint(0xe0000 + ch.codePointAt(0)!)).join('');
    expect(revealHiddenCharacters(`ok${tags}`)).toBe('ok<U+E0072><U+E006D>');
  });

  it('leaves ordinary text, other scripts included, alone', () => {
    expect(revealHiddenCharacters('rm -rf ./tmp && echo héllo 日本')).toBe(
      'rm -rf ./tmp && echo héllo 日本'
    );
  });

  it.each([
    // One U+FE0F straight after an emoji only asks for its colour form (DOR-5075).
    ['a heart', '\u2764\uFE0F'],
    ['a thumbs up', '\u{1F44D}\uFE0F'],
  ])('leaves one U+FE0F after an emoji alone: %s', (_what, emoji) => {
    expect(revealHiddenCharacters(`ok ${emoji} done`)).toBe(`ok ${emoji} done`);
  });

  it.each([
    ['alone', '\uFE0F', '<U+FE0F>'],
    ['at the start', '\uFE0Fok', '<U+FE0F>ok'],
    ['after a letter', 'a\uFE0F', 'a<U+FE0F>'],
    ['twice after an emoji, the second', '\u2764\uFE0F\uFE0F', '\u2764\uFE0F<U+FE0F>'],
    ['U+FE0E after an emoji', '\u2764\uFE0E', '\u2764<U+FE0E>'],
    ['another selector after an emoji', '\u{1F44D}\uFE00', '\u{1F44D}<U+FE00>'],
    ['a supplementary selector after an emoji', '\u{1F44D}\u{E0100}', '\u{1F44D}<U+E0100>'],
  ])('still marks a variation selector %s', (_what, text, shown) => {
    expect(revealHiddenCharacters(text)).toBe(shown);
  });
});

describe('splitHiddenCharacters', () => {
  it('splits text into what shows and each hidden character, by its code point', () => {
    expect(splitHiddenCharacters('pay\u200Bthe\u202Einvoice\u{E0041}')).toEqual([
      { text: 'pay' },
      { codePoint: 'U+200B' },
      { text: 'the' },
      { codePoint: 'U+202E' },
      { text: 'invoice' },
      { codePoint: 'U+E0041' },
    ]);
  });

  it('keeps hidden characters in a row apart, and adds no empty text between them', () => {
    expect(splitHiddenCharacters('\u200B\u200Cok')).toEqual([
      { codePoint: 'U+200B' },
      { codePoint: 'U+200C' },
      { text: 'ok' },
    ]);
  });

  it('returns ordinary text as one piece, and empty text as none', () => {
    expect(splitHiddenCharacters('rm -rf ./tmp 日本')).toEqual([{ text: 'rm -rf ./tmp 日本' }]);
    expect(splitHiddenCharacters('')).toEqual([]);
  });

  it('matches exactly what revealHiddenCharacters marks, the emoji selector included', () => {
    const text = 'a\u2764\uFE0F b\uFE0F c\u2764\uFE0F\uFE0F \u{E0100}\u00AD';
    const rejoined = splitHiddenCharacters(text)
      .map((segment) => ('text' in segment ? segment.text : `<${segment.codePoint}>`))
      .join('');
    expect(rejoined).toBe(revealHiddenCharacters(text));
    expect(rejoined).toBe('a\u2764\uFE0F b<U+FE0F> c\u2764\uFE0F<U+FE0F> <U+E0100><U+00AD>');
  });

  it('agrees with revealHiddenCharacters on every code point, after a letter and after an emoji', () => {
    const rejoin = (text: string) =>
      splitHiddenCharacters(text)
        .map((segment) => ('text' in segment ? segment.text : `<${segment.codePoint}>`))
        .join('');
    const disagree: string[] = [];
    for (let cp = 0; cp <= 0xe01ef; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates are not characters
      const ch = String.fromCodePoint(cp);
      for (const text of [`a${ch}b`, `\u2764${ch}b`]) {
        if (rejoin(text) !== revealHiddenCharacters(text)) disagree.push(text);
      }
    }
    expect(disagree).toEqual([]);
  });

  it('flags every variation selector except one U+FE0F right after an emoji', () => {
    const selectors = [
      ...Array.from({ length: 16 }, (_, i) => 0xfe00 + i),
      ...Array.from({ length: 240 }, (_, i) => 0xe0100 + i),
      0x180b,
      0x180c,
      0x180d,
      0x180f,
    ];
    const missed = selectors.filter((cp) => {
      const ch = String.fromCodePoint(cp);
      const afterLetter = revealHiddenCharacters(`a${ch}`) === `a${ch}`;
      const afterEmoji = cp !== 0xfe0f && revealHiddenCharacters(`\u2764${ch}`) === `\u2764${ch}`;
      return afterLetter || afterEmoji;
    });
    expect(missed).toEqual([]);
  });
});

describe('describeProgramLine', () => {
  it('quotes the program and every argument, so argument boundaries are visible', () => {
    expect(describeProgramLine('npx', ['-y', 'db mcp'])).toBe('"npx" "-y" "db mcp"');
  });

  it('shows hidden characters inside an argument', () => {
    expect(describeProgramLine('echo', ['‮txt'])).toBe('"echo" "<U+202E>txt"');
  });
});

describe('describeHookEvent', () => {
  it('writes a matcher out whole, so a line break cannot fake a card line', () => {
    // Purpose: approval cards bind this text (DOR-2696). A raw matcher with a
    // newline would print a line of its own the package wrote.
    const phrase = describeHookEvent('PreToolUse', 'Bash\nApproving lets nothing run.');
    expect(phrase).not.toContain('\n');
    expect(phrase).toBe('before the agent uses a tool ("Bash\\nApproving lets nothing run.")');
  });

  it('writes an unknown event out whole too', () => {
    // Purpose: the event name is as package-chosen as the matcher.
    expect(describeHookEvent('Odd\nEvent')).toBe('on "Odd\\nEvent"');
  });
});
