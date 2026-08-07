import { describe, it, expect } from 'vitest';
import {
  HANDLE_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  HANDLE_PATTERN,
  deriveHandle,
  normalizeHandle,
  validateHandle,
} from '../handle.js';

/**
 * The mention grammar, copied here ON PURPOSE rather than imported.
 *
 * `MENTION_PATTERN` lives in the server (`services/rooms/mentions.ts`), which
 * `@dorkos/shared` may not import — it is the layer below. The round-trip
 * assertion below is the one that makes the handle grammar and the resolver one
 * system, so it has to be asserted from here as well as from the server side,
 * and a copy that drifts fails loudly the moment either literal changes.
 */
const MENTION_PATTERN = /@([A-Za-z0-9][A-Za-z0-9_.-]*)/g;
const TRAILING_PUNCTUATION = /[.\-_]+$/;

const LEGAL = [
  'ab',
  'ana',
  'mio-clicker-pm',
  'bella-codebase-2',
  'art-blocks-analytics',
  'a_b',
  'a.b',
  '1ab',
  '144x.co',
  '144mono',
  'next_starter',
  'doriancollier.com',
  'a'.repeat(HANDLE_MAX_LENGTH),
];

const ILLEGAL: readonly [string, string][] = [
  ['', 'the empty string'],
  ['a', 'one character'],
  ['a'.repeat(HANDLE_MAX_LENGTH + 1), '33 characters'],
  ['Ana', 'an uppercase letter'],
  ['.ana', 'a leading dot'],
  ['-ana', 'a leading hyphen'],
  ['_ana', 'a leading underscore'],
  ['ana.', 'a trailing dot'],
  ['ana-', 'a trailing hyphen'],
  ['ana_', 'a trailing underscore'],
  ['a..b', 'consecutive dots'],
  ['ana bo', 'a space'],
  ['аna', 'a Cyrillic a'],
  ['ａna', 'a fullwidth a'],
  ['an​а', 'an embedded zero-width space'],
  ['ana@bo', 'an at sign'],
  ['ana/bo', 'a slash'],
];

describe('HANDLE_PATTERN', () => {
  it.each(LEGAL)('accepts %s', (handle) => {
    expect(HANDLE_PATTERN.test(handle)).toBe(true);
  });

  it.each(ILLEGAL)('rejects %s (%s)', (handle) => {
    expect(HANDLE_PATTERN.test(handle)).toBe(false);
  });

  it('bounds are the ones the pattern enforces', () => {
    expect(HANDLE_MIN_LENGTH).toBe(2);
    expect(HANDLE_MAX_LENGTH).toBe(32);
    expect(HANDLE_PATTERN.test('a'.repeat(HANDLE_MIN_LENGTH))).toBe(true);
    expect(HANDLE_PATTERN.test('a'.repeat(HANDLE_MIN_LENGTH - 1))).toBe(false);
  });
});

/**
 * The assertion that makes the grammar and the resolver one system: everything
 * this charset can spell survives being written after an `@` and read back.
 */
describe('every legal handle round-trips the mention grammar', () => {
  it.each(LEGAL)('%s is captured whole from @handle', (handle) => {
    const matches = [...`@${handle}`.matchAll(MENTION_PATTERN)];
    expect(matches).toHaveLength(1);
    expect(matches[0]![1]).toBe(handle);
  });

  it.each(LEGAL)('%s loses nothing to the trailing-punctuation shave', (handle) => {
    expect(handle.replace(TRAILING_PUNCTUATION, '')).toBe(handle);
  });
});

describe('normalizeHandle', () => {
  it('lowercases and trims', () => {
    expect(normalizeHandle('  Ana  ')).toBe('ana');
  });

  it('treats the empty string as absent', () => {
    expect(normalizeHandle('')).toBeUndefined();
  });

  it('treats whitespace as absent', () => {
    expect(normalizeHandle('   ')).toBeUndefined();
  });

  it('does not validate — an illegal handle still normalizes', () => {
    expect(normalizeHandle('Ana Bo')).toBe('ana bo');
  });
});

describe('validateHandle', () => {
  it.each(LEGAL)('accepts %s', (handle) => {
    expect(validateHandle(handle)).toEqual({ valid: true });
  });

  it.each(ILLEGAL)('rejects %s (%s) with a reason', (handle) => {
    const result = validateHandle(handle);
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('says which bound was missed', () => {
    expect(validateHandle('a').error).toMatch(/2 and 32/);
    expect(validateHandle('a'.repeat(33)).error).toMatch(/2 and 32/);
  });
});

describe('deriveHandle', () => {
  const none = new Set<string>();

  it.each([
    ['dopel', 'dopel'],
    ['mio-clicker-pm', 'mio-clicker-pm'],
    ['mio-click-code', 'mio-click-code'],
    ['LifeOS', 'lifeos'],
    ['144mono', '144mono'],
    ['144x.co', '144x.co'],
    ['doriancollier.com', 'doriancollier.com'],
    ['next_starter', 'next_starter'],
    ['temp-assetops-aced-iframe', 'temp-assetops-aced-iframe'],
  ])('preserves the address %s already answers to', (name, expected) => {
    expect(deriveHandle(name, none)).toBe(expected);
  });

  it.each([
    ['Art Blocks Analytics', 'art-blocks-analytics'],
    ['Bella Codebase', 'bella-codebase'],
    ['DorkOS Marketplace', 'dorkos-marketplace'],
    ['Mio Clicker PM', 'mio-clicker-pm'],
    ['Ana Reyes', 'ana-reyes'],
  ])('slugifies the spaced name %s', (name, expected) => {
    expect(deriveHandle(name, none)).toBe(expected);
  });

  it('collapses consecutive dots', () => {
    expect(deriveHandle('a..b', none)).toBe('a.b');
  });

  it('trims to an alphanumeric first and last character', () => {
    expect(deriveHandle('...ana...', none)).toBe('ana');
    expect(deriveHandle('-ana-', none)).toBe('ana');
  });

  it('collapses a run of forbidden characters to one hyphen', () => {
    expect(deriveHandle('ana   //  bo', none)).toBe('ana-bo');
  });

  it('cuts to 32 and does not end on a separator', () => {
    // 31 characters, then a space, then more: a naive cut lands on the space.
    const derived = deriveHandle('a'.repeat(31) + ' bo', none);
    expect(derived).toBe('a'.repeat(31));
    expect(derived!.length).toBeLessThanOrEqual(HANDLE_MAX_LENGTH);
    expect(validateHandle(derived!)).toEqual({ valid: true });
  });

  it('always returns something legal or nothing at all', () => {
    for (const name of ['Art Blocks Analytics', 'x', '', '   ', '...', '日本語', 'a'.repeat(80)]) {
      const derived = deriveHandle(name, none);
      if (derived !== undefined) expect(validateHandle(derived)).toEqual({ valid: true });
    }
  });

  it('gives nothing when the name cannot spell a legal handle', () => {
    expect(deriveHandle('日本語', none)).toBeUndefined();
    expect(deriveHandle('', none)).toBeUndefined();
    expect(deriveHandle('.', none)).toBeUndefined();
    // One character is legal input and an illegal handle: 2 is the floor.
    expect(deriveHandle('x', none)).toBeUndefined();
  });

  it('de-collides with a decimal counter, not random digits', () => {
    expect(deriveHandle('Bella Codebase', new Set(['bella-codebase']))).toBe('bella-codebase-2');
    expect(deriveHandle('Bella Codebase', new Set(['bella-codebase', 'bella-codebase-2']))).toBe(
      'bella-codebase-3'
    );
  });

  it('matches `taken` case-insensitively, because the index does', () => {
    expect(deriveHandle('Bella Codebase', new Set(['BELLA-CODEBASE']))).toBe('bella-codebase-2');
  });

  it('keeps a de-collided handle inside the length bound', () => {
    const stem = 'a'.repeat(HANDLE_MAX_LENGTH);
    const derived = deriveHandle(stem, new Set([stem]));
    expect(derived).toBeDefined();
    expect(derived!.length).toBeLessThanOrEqual(HANDLE_MAX_LENGTH);
    expect(derived).toBe('a'.repeat(HANDLE_MAX_LENGTH - 2) + '-2');
    expect(validateHandle(derived!)).toEqual({ valid: true });
  });

  it('produces no collision over a fixture of every name shape on one machine', () => {
    const names = [
      'dopel',
      'mio-clicker-pm',
      'mio-click-code',
      'LifeOS',
      '144mono',
      '144x.co',
      'doriancollier.com',
      'next_starter',
      'Art Blocks Analytics',
      'Bella Codebase',
      'DorkOS Marketplace',
      'temp-assetops-aced-iframe',
    ];
    const taken = new Set<string>();
    for (const name of names) {
      const derived = deriveHandle(name, taken);
      expect(derived).toBeDefined();
      expect(validateHandle(derived!)).toEqual({ valid: true });
      expect(taken.has(derived!)).toBe(false);
      taken.add(derived!);
    }
    expect(taken.size).toBe(names.length);
  });
});
