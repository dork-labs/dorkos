/**
 * What the two sanitizers do with characters a person cannot see (DOR-5133).
 *
 * A message body and a label both reach a model, and a model reads every code
 * point, drawn or not. So anything that draws nothing has to go, from both,
 * while everything a person does see, emoji sequences included, stays exactly
 * as written.
 */
import { describe, it, expect } from 'vitest';
import { defuseSystemTags, sanitizeIdentity, IDENTITY_MAX_LENGTH } from '../untrusted-text.js';

/** A body, defused over a small tag set. */
const body = (text: string): string => defuseSystemTags(text, ['room_context', 'system-reminder']);
/** A label, or the empty string when nothing survives. */
const name = (text: string): string => sanitizeIdentity(text) ?? '';

/** Every code point from `from` to `to`, inclusive, as characters. */
const range = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i));

/** Each kind of character that draws nothing, by what it is. */
const HIDDEN: Array<[string, string[]]> = [
  ['bidi isolates', range(0x2066, 0x2069)],
  ['the Arabic letter mark', ['؜']],
  ['the Mongolian vowel separator', ['᠎']],
  ['the combining grapheme joiner', ['͏']],
  ['the deprecated format characters', range(0x206a, 0x206f)],
  ['Hangul fillers', ['ᅟ', 'ᅠ', 'ㅤ', 'ﾠ']],
  ['variation selectors', range(0xfe00, 0xfe0f)],
  ['the variation selectors supplement', range(0xe0100, 0xe01ef)],
  ['zero-width joiners between plain letters', ['‌', '‍']],
];

/** Emoji and scripts people really type, each of which must come back unchanged. */
const VISIBLE: Array<[string, string]> = [
  ['a heart with its colour selector', '❤️'],
  ['a copyright sign with its colour selector', '©️'],
  ['a keycap one', '1️⃣'],
  ['a keycap hash', '#️⃣'],
  ['a keycap star', '*️⃣'],
  ['a family', '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'],
  ['a rainbow flag', '\u{1F3F3}️‍\u{1F308}'],
  ['a technologist with a skin tone', '\u{1F469}\u{1F3FD}‍\u{1F4BB}'],
  ['a man with a beard', '\u{1F9D4}‍♂️'],
  ['the flag of England', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'],
  ['the flag of Scotland', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'],
  ['the flag of Wales', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}'],
  ['a country flag', '\u{1F1EF}\u{1F1F5}'],
  ['Persian with a non-joiner', 'می‌خواهم'],
  ['Devanagari with a joiner', 'क्‍ष'],
];

describe('characters that draw nothing', () => {
  describe.each(HIDDEN)('%s', (_kind, characters) => {
    it('are removed from a message body', () => {
      for (const ch of characters) {
        const cp = ch.codePointAt(0)!.toString(16);
        expect(body(`pay${ch}the invoice`), `U+${cp}`).toBe('paythe invoice');
      }
    });

    it('are removed from a name', () => {
      for (const ch of characters) {
        const cp = ch.codePointAt(0)!.toString(16);
        expect(name(`Ana${ch}Kai`), `U+${cp}`).toBe('AnaKai');
      }
    });
  });

  it('cannot spell a byte per character on any text', () => {
    // One selector after each letter is a byte nobody sees; none may survive.
    const carried = [...'hello']
      .map((letter, i) => `${letter}${String.fromCodePoint(0xe0100 + i * 37)}`)
      .join('');
    expect(body(carried)).toBe('hello');
    expect(name(carried)).toBe('hello');
    // After an emoji, too: only one U+FE0F is its colour form.
    expect(body('\u{1F44D}︀\u{E0142}️️')).toBe('\u{1F44D}');
    expect(body('❤️️\u{E0100}')).toBe('❤️');
  });

  it('keeps a joiner only between two characters it can join', () => {
    expect(body('‍م')).toBe('م');
    expect(body('م‌')).toBe('م');
    expect(body('م‍‌‍م')).toBe('مم');
    expect(body('م ‌م')).toBe('م م');
    expect(body('\u{1F468}‍')).toBe('\u{1F468}');
  });

  it('keeps a keycap selector only inside a keycap', () => {
    expect(body('1️')).toBe('1');
    expect(body('x️⃣')).toBe('x⃣');
  });

  it('turns the line and paragraph separators into a plain line break in a body', () => {
    expect(body('one two three')).toBe('one\ntwo\nthree');
    expect(name('Ana Kai')).toBe('Ana Kai');
  });
});

describe('what a person does see', () => {
  it.each(VISIBLE)('keeps %s in a body and a name', (_what, text) => {
    expect(body(`ok ${text} done`)).toBe(`ok ${text} done`);
    expect(name(`Ana ${text}`)).toBe(`Ana ${text}`);
  });
});

describe('the result', () => {
  /** A tiny seeded generator, so a failure names an input that reproduces. */
  function seeded(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
  }

  const POOL = [
    'a',
    ' ',
    '<',
    '/',
    'room_context',
    'م',
    '्',
    '❤',
    '\u{1F468}',
    '\u{1F3F4}',
    '1',
    '#',
    '⃣',
    '️',
    '︎',
    '\u{E0100}',
    '‌',
    '‍',
    '​',
    '⁦',
    'ㅤ',
    ' ',
    '\u{E0067}',
    '\u{E0062}',
    '\u{E0065}',
    '\u{E006E}',
    '\u{E007F}',
    '\uD800',
    '\uDC00',
  ];

  it('is the same after a second pass', () => {
    const random = seeded(5133);
    for (let i = 0; i < 2_000; i += 1) {
      const text = Array.from({ length: 12 }, () => POOL[Math.floor(random() * POOL.length)]).join(
        ''
      );
      const once = body(text);
      expect(body(once), JSON.stringify(text)).toBe(once);
      const label = sanitizeIdentity(text);
      if (label !== undefined) expect(sanitizeIdentity(label), JSON.stringify(text)).toBe(label);
    }
  });

  it('stays linear on long input', () => {
    const fuel = (n: number): string => 'م‍\u{1F468}️\u{E0100}'.repeat(n);
    const time = (n: number): number => {
      const text = fuel(n);
      const started = performance.now();
      body(text);
      sanitizeIdentity(text, text.length);
      return performance.now() - started;
    };
    time(500); // warm up
    const small = Math.max(time(2_000), 0.05);
    const large = time(16_000);
    expect(large / small).toBeLessThan(50);
  });
});

describe('a capped name', () => {
  it('never ends on half a character, however many halves trail', () => {
    const capped = sanitizeIdentity(`${'x'.repeat(IDENTITY_MAX_LENGTH - 2)}\uD800\uD800yy`);
    expect(capped).toBe(`${'x'.repeat(IDENTITY_MAX_LENGTH - 2)}yy`);
    expect(capped).not.toMatch(/[\uD800-\uDFFF]/);
    expect(sanitizeIdentity('Ana\uDC00\uD800Kai')).toBe('AnaKai');
  });

  it('drops a joiner the cap left with nothing after it', () => {
    const capped = sanitizeIdentity(`${'x'.repeat(IDENTITY_MAX_LENGTH - 3)}\u{1F468}‍\u{1F469}`);
    expect(capped).toBe(`${'x'.repeat(IDENTITY_MAX_LENGTH - 3)}\u{1F468}`);
  });
});
