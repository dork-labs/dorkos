/**
 * @vitest-environment node
 *
 * Frame parsing and the NIP-10 tag reading, at the edges the happy path never
 * reaches.
 *
 * A relay speaks NIPs this adapter does not, and will speak more of them later.
 * The parser's job is to be uninterested in all of it without falling over —
 * which is a property only a test with garbage in it can demonstrate.
 */
import { describe, expect, it } from 'vitest';
import { hasMarker, parseRelayFrame, threadTags, type NostrEvent } from '../buzz-protocol.js';

/** A minimally well-formed event, for the frames that carry one. */
const EVENT: NostrEvent = {
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 1_780_000_000,
  kind: 9,
  tags: [['h', 'channel']],
  content: 'hello',
  sig: 'c'.repeat(128),
};

describe('parseRelayFrame', () => {
  it('reads the six frames this adapter acts on', () => {
    expect(parseRelayFrame(JSON.stringify(['AUTH', 'challenge']))).toEqual({
      type: 'AUTH',
      challenge: 'challenge',
    });
    expect(parseRelayFrame(JSON.stringify(['EVENT', 'sub', EVENT]))).toEqual({
      type: 'EVENT',
      subscriptionId: 'sub',
      event: EVENT,
    });
    expect(parseRelayFrame(JSON.stringify(['EOSE', 'sub']))).toEqual({
      type: 'EOSE',
      subscriptionId: 'sub',
    });
    expect(parseRelayFrame(JSON.stringify(['CLOSED', 'sub', 'restricted: gone']))).toEqual({
      type: 'CLOSED',
      subscriptionId: 'sub',
      message: 'restricted: gone',
    });
    expect(parseRelayFrame(JSON.stringify(['OK', 'id', false, 'nope']))).toEqual({
      type: 'OK',
      eventId: 'id',
      accepted: false,
      message: 'nope',
    });
    expect(parseRelayFrame(JSON.stringify(['NOTICE', 'heads up']))).toEqual({
      type: 'NOTICE',
      message: 'heads up',
    });
  });

  it.each([
    ['not JSON at all', 'this is not json'],
    ['a JSON value that is not an array', '{"type":"EVENT"}'],
    ['an empty array', '[]'],
    ['a verb this adapter does not act on', '["COUNT","sub",{"count":3}]'],
    ['an EVENT whose payload is not an event', '["EVENT","sub",{"nope":true}]'],
    ['an OK with no verdict', '["OK","id"]'],
  ])('drops %s rather than throwing', (_case, raw) => {
    // A read-only client that fell over on somebody else's feature would be
    // broken by a relay upgrade it has no stake in.
    expect(parseRelayFrame(raw)).toBeNull();
  });
});

describe('tag reading', () => {
  it('treats a bare marker, an empty value and "true" as the same yes', () => {
    const tagged = { ...EVENT, tags: [['public'], ['archived', 'true'], ['hidden', '']] };
    expect(hasMarker(tagged, 'public')).toBe(true);
    expect(hasMarker(tagged, 'archived')).toBe(true);
    expect(hasMarker(tagged, 'hidden')).toBe(true);
    expect(hasMarker(tagged, 'private')).toBe(false);
  });

  it('reports an unmarked e tag without a marker', () => {
    // Buzz's ingest only establishes ancestry from the MARKED form, so an
    // unmarked tag never made an event a reply on the way in. It is reported
    // here so the projection can decide, rather than being silently promoted.
    const tagged = {
      ...EVENT,
      tags: [
        ['e', 'r'.repeat(64), '', 'root'],
        ['e', 'p'.repeat(64)],
      ],
    };
    expect(threadTags(tagged)).toEqual([
      { eventId: 'r'.repeat(64), marker: 'root' },
      { eventId: 'p'.repeat(64) },
    ]);
  });
});
