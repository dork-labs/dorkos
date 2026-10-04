/**
 * Tests for the helpers every marketplace consent surface uses to show a
 * package's commands exactly as they will run (DOR-2195).
 */
import { describe, expect, it } from 'vitest';
import {
  describeHookEvent,
  describeProgramLine,
  revealHiddenCharacters,
} from '../marketplace-schemas.js';

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
