/**
 * Words from somebody other than the person here, defused before Claude Code reads them
 * (DOR-2955). Each case below was measured against the pinned binary: a `@` at the start or after
 * whitespace is read as a file, and a leading `/` runs a command.
 */
import { describe, expect, it } from 'vitest';
import { defuseFileReferences, defuseUntrustedPrompt } from '../prompt-defuse.js';

const ZW = '\u200B';

describe('defuseFileReferences', () => {
  it.each([
    ['@/etc/hosts', `${ZW}@/etc/hosts`],
    ['see @/etc/hosts now', `see ${ZW}@/etc/hosts now`],
    ['line\n@~/.ssh/id_rsa', `line\n${ZW}@~/.ssh/id_rsa`],
    ['tab\t@keys.txt', `tab\t${ZW}@keys.txt`],
    ['nbsp\u00a0@keys.txt', `nbsp\u00a0${ZW}@keys.txt`],
    ['quoted @"a b/c.txt"', `quoted ${ZW}@"a b/c.txt"`],
  ])('defuses %j', (input, expected) => {
    expect(defuseFileReferences(input)).toBe(expected);
  });

  it.each(['mail me at ana@example.com', 'packages/@dorkos/shared', '(@x)', '"@x"'])(
    'leaves an @ Claude Code does not read alone: %j',
    (input) => {
      expect(defuseFileReferences(input)).toBe(input);
    }
  );

  it('is idempotent', () => {
    const once = defuseFileReferences('a @b @c');
    expect(defuseFileReferences(once)).toBe(once);
  });
});

describe('defuseUntrustedPrompt', () => {
  it.each(['/leak', '  /compact', '\n/leak args'])('defuses a leading command: %j', (input) => {
    const out = defuseUntrustedPrompt(input);
    expect(out.startsWith(ZW)).toBe(true);
    expect(out.slice(1)).toBe(input);
  });

  it('leaves a slash that does not start the message, and plain words, alone', () => {
    expect(defuseUntrustedPrompt('hi\n/leak')).toBe('hi\n/leak');
    expect(defuseUntrustedPrompt('what is 1/2?')).toBe('what is 1/2?');
  });

  it('defuses both at once, and only once', () => {
    const out = defuseUntrustedPrompt('/leak @/etc/hosts');
    expect(out).toBe(`${ZW}/leak ${ZW}@/etc/hosts`);
    expect(defuseUntrustedPrompt(out)).toBe(out);
  });
});
