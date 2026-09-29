import { describe, expect, it } from 'vitest';
import { parseAppSearch, readSearchValue, stringifyAppSearch } from '../router-search';

describe('readSearchValue', () => {
  it('reads canonical JSON scalars and structures as values', () => {
    expect(readSearchValue('3')).toBe(3);
    expect(readSearchValue('true')).toBe(true);
    expect(readSearchValue('null')).toBeNull();
    expect(readSearchValue('[1,2]')).toEqual([1, 2]);
  });

  it('keeps text that only looks like a number as text', () => {
    for (const raw of ['1.10', '-0', '1e3', '007', '3.0']) expect(readSearchValue(raw)).toBe(raw);
  });

  it('drops quotes only when they were an escape', () => {
    expect(readSearchValue('"3"')).toBe('3');
    expect(readSearchValue('"x"')).toBe('"x"');
  });
});

describe('the app search round trip', () => {
  it.each(['?page=3&v=1.10&n=-0&e=1e3&q=%22x%22&t=hi', '?entry=12&id=room-1', '?list=%5B1%2C2%5D'])(
    'writes back exactly what it read: %s',
    (search) => {
      expect(stringifyAppSearch(parseAppSearch(search))).toBe(search);
    }
  );

  it('writes a string that would read as something else so it reads back as itself', () => {
    for (const value of ['3', 'true', 'null', '"3"', '[1]', '1.10', '"x"', 'plain']) {
      expect(parseAppSearch(stringifyAppSearch({ value }))).toEqual({ value });
    }
  });
});
