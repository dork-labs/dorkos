/**
 * The one builder for links into a conversation (DOR-2077).
 */
import { describe, expect, it } from 'vitest';
import { defaultParseSearch, defaultStringifySearch } from '@tanstack/react-router';
import { sessionHref, sessionSearchSchema, toSession, type SessionSearch } from '../session-link';

describe('toSession', () => {
  it('is the session route with the params it was given', () => {
    expect(toSession({ session: 'abc', dir: '/p' })).toEqual({
      to: '/session',
      search: { session: 'abc', dir: '/p' },
    });
  });

  it('passes a function of the current params through untouched', () => {
    const update = (prev: SessionSearch) => ({ ...prev, dir: '/q' });
    expect(toSession(update)).toEqual({ to: '/session', search: update });
  });
});

describe('sessionHref', () => {
  it('always has the route path in front of the session id', () => {
    // The tunnel's "copy session link" used to be the origin plus `?session=`,
    // with no `/session` — the half of DOR-2077 that was a wrong address.
    expect(sessionHref({ session: 'abc' })).toBe('/session?session=abc');
  });

  /**
   * Values a hand-built query gets wrong: a path with spaces and `&`, a prompt
   * that is a number or a boolean as far as a JSON parser is concerned, text
   * outside ASCII.
   */
  const AWKWARD: SessionSearch[] = [
    { session: 'abc', dir: '/Users/kai/my code & more' },
    { dir: '/p', prompt: '123', runtime: 'codex' },
    { session: 'abc', prompt: 'true' },
    { session: 'abc', prompt: 'null' },
    { session: 'abc', prompt: '{"a":1}' },
    { session: 'abc', prompt: 'résumé — 東京' },
    { session: 'abc', send: '1' },
  ];

  it.each(AWKWARD)('writes %o exactly as the router would', (search) => {
    // Purpose: an href is followed by the router's own parser, so the string
    // has to be the one the router writes for itself — otherwise `prompt=123`
    // comes back as a number and the route refuses it.
    expect(sessionHref(search)).toBe(`/session${defaultStringifySearch(search)}`);
  });

  it.each(AWKWARD)('reads %o back as the same params', (search) => {
    const query = sessionHref(search).slice('/session'.length);
    expect(sessionSearchSchema.parse(defaultParseSearch(query))).toEqual(search);
  });
});
