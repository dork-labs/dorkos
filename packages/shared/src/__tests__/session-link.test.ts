import { describe, expect, it } from 'vitest';
import { SESSION_ROUTE, chatRefMarkdownLink, sessionPath } from '../session-link.js';

describe('sessionPath', () => {
  it('puts the route path in front of the session id', () => {
    // Purpose: the bug this module exists for (DOR-2077) was a link carrying
    // `?session=` with no `/session` in front of it.
    expect(sessionPath({ session: 'abc' })).toBe('/session?session=abc');
    expect(SESSION_ROUTE).toBe('/session');
  });

  it('keeps the order it was given and drops params with no value', () => {
    expect(sessionPath({ session: 'abc', dir: undefined, runtime: 'codex' })).toBe(
      '/session?session=abc&runtime=codex'
    );
  });

  it('is the bare route when nothing names a conversation', () => {
    expect(sessionPath({})).toBe('/session');
  });

  it('encodes a value that would otherwise break the query', () => {
    expect(sessionPath({ prompt: '/Users/kai/my code&more' })).toBe(
      '/session?prompt=%2FUsers%2Fkai%2Fmy+code%26more'
    );
  });

  it('keeps directories out of copied session links across server and desktop callers', () => {
    expect(
      sessionPath({
        session: 'abc',
        dir: '/Users/private/project',
        agentPath: '/Users/private/agent',
      })
    ).toBe('/session?session=abc');
    expect(() => sessionPath({ dir: '/Users/private/project' })).toThrow(/opaque/);
  });

  it('quotes a string the router would otherwise read back as a number or a boolean', () => {
    // Purpose: the router parses every value as JSON when it can, so an
    // unquoted `123` comes back as the NUMBER 123 and fails the route's
    // `z.string()`. Quoting mirrors what the router itself writes.
    expect(sessionPath({ prompt: '123' })).toBe('/session?prompt=%22123%22');
    expect(sessionPath({ prompt: 'true' })).toBe('/session?prompt=%22true%22');
    // A string that only LOOKS like the start of JSON stays as it is.
    expect(sessionPath({ session: '1f2e-uuid' })).toBe('/session?session=1f2e-uuid');
  });
});

describe('chatRefMarkdownLink (DOR-2824, DOR-5202)', () => {
  const id = '6572731c-1111-4222-8333-444455556666';

  it('names the chat by its title and links its /r/ reference', () => {
    expect(chatRefMarkdownLink(id, 'Rooms: always answer people')).toBe(
      `[Rooms: always answer people](/r/dork:chat:${id})`
    );
  });

  it('calls a chat with no title what the app calls it', () => {
    expect(chatRefMarkdownLink(id, null)).toBe(`[New chat](/r/dork:chat:${id})`);
    expect(chatRefMarkdownLink(id, undefined)).toBe(`[New chat](/r/dork:chat:${id})`);
    expect(chatRefMarkdownLink(id, '   ')).toBe(`[New chat](/r/dork:chat:${id})`);
  });

  it('keeps a title from breaking out of the link text', () => {
    expect(chatRefMarkdownLink(id, 'a ] b [c](https://evil.example) \\')).toBe(
      `[a \\] b \\[c\\](https://evil.example) \\\\](/r/dork:chat:${id})`
    );
    expect(chatRefMarkdownLink(id, 'one\n\n# two')).toBe(`[one # two](/r/dork:chat:${id})`);
  });

  it.each([
    ['a dot', 'abc.def'],
    ['a slash', 'abc/def'],
    ['more than 64 characters', 'a'.repeat(65)],
  ])('falls back to the /session link for an id with %s', (_why, odd) => {
    // Purpose: a chat whose id cannot be a `dork:` reference still links, and
    // never as a `/r/` link the route would refuse.
    expect(chatRefMarkdownLink(odd, 'Build')).toBe(`[Build](${sessionPath({ session: odd })})`);
    expect(chatRefMarkdownLink(odd, 'Build')).not.toContain('/r/');
  });
});
