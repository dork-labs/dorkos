/**
 * Words from somebody other than the person here, defused before Claude Code reads them
 * (DOR-2955). Measured against the pinned binary: its `@` parser starts at `(^|[\s。、？！])@`
 * (paths, `@agent-…` and `@server:uri` alike), and a leading `/` runs a command. Every `@` gets a
 * zero-width space, so no start set has to be guessed right.
 */
import { describe, expect, it } from 'vitest';
import { defuseFileReferences, defuseUntrustedPrompt } from '../untrusted-text.js';

const ZW = '​';

describe('defuseFileReferences', () => {
  it.each([
    ['@/etc/hosts', `${ZW}@/etc/hosts`],
    ['see @/etc/hosts now', `see ${ZW}@/etc/hosts now`],
    ['line\n@~/.ssh/id_rsa', `line\n${ZW}@~/.ssh/id_rsa`],
    ['tab\t@keys.txt', `tab\t${ZW}@keys.txt`],
    ['nbsp\u00a0@keys.txt', `nbsp\u00a0${ZW}@keys.txt`],
    ['quoted @"a b/c.txt"', `quoted ${ZW}@"a b/c.txt"`],
    // The review's BLOCKER: four more characters the parser starts after.
    ['見て。@/tmp/secret.txt', `見て。${ZW}@/tmp/secret.txt`],
    ['これ、@/tmp/secret.txt', `これ、${ZW}@/tmp/secret.txt`],
    ['何？@/tmp/secret.txt', `何？${ZW}@/tmp/secret.txt`],
    ['はい！@/tmp/secret.txt', `はい！${ZW}@/tmp/secret.txt`],
    // The same parser's other two forms.
    ['ask @agent-explore to look', `ask ${ZW}@agent-explore to look`],
    ['read @github:repos/x/y', `read ${ZW}@github:repos/x/y`],
    // And every other `@`, whatever comes before it.
    ['ana@example.com', `ana${ZW}@example.com`],
    ['(@x) "@y"', `(${ZW}@x) "${ZW}@y"`],
  ])('defuses %j', (input, expected) => {
    expect(defuseFileReferences(input)).toBe(expected);
  });

  it('leaves text with no @ alone', () => {
    expect(defuseFileReferences('nothing to see')).toBe('nothing to see');
  });

  it('is idempotent', () => {
    const once = defuseFileReferences('a @b 。@c x@y');
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
