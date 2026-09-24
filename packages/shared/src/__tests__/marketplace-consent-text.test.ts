/**
 * Tests for the helpers every marketplace consent surface uses to show a
 * package's commands exactly as they will run (DOR-2195).
 */
import { describe, expect, it } from 'vitest';
import { describeProgramLine, revealHiddenCharacters } from '../marketplace-schemas.js';

describe('revealHiddenCharacters', () => {
  it('shows direction-changing and zero-width characters as visible markers', () => {
    // Purpose: U+202E can make `echo ‮gnp.exe` read as something else, and
    // a zero-width space hides inside a word. A person must see both.
    expect(revealHiddenCharacters('a‮b​c⁦d﻿')).toBe('a<U+202E>b<U+200B>c<U+2066>d<U+FEFF>');
  });

  it('leaves ordinary text, other scripts included, alone', () => {
    expect(revealHiddenCharacters('rm -rf ./tmp && echo héllo 日本')).toBe(
      'rm -rf ./tmp && echo héllo 日本'
    );
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
