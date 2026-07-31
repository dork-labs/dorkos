/**
 * @vitest-environment node
 *
 * The Buzz cursor's four refusals and its ordering.
 *
 * The conformance suite proves a cursor from another room and another community
 * is rejected. This file covers the rest of the surface — a malformed token, a
 * token another adapter minted, and the total order the whole design rests on —
 * because a cursor that silently accepted one of those would resume from the
 * wrong place and drop whatever fell in between.
 */
import { describe, expect, it } from 'vitest';
import {
  StaleCommunityCursorError,
  type CommunityCursor,
  type CommunityRef,
} from '@dorkos/shared/community-adapter';
import {
  BEGINNING,
  comparePositions,
  isBeginning,
  mintBuzzCursor,
  readBuzzCursor,
} from '../buzz-cursor.js';

const COMMUNITY = 'buzz-one' as CommunityRef;
const ROOM = '00000000-0000-4000-8000-000000000001';
const EVENT_ID = 'c'.repeat(64);

describe('the Buzz cursor', () => {
  it('round-trips a position', () => {
    const cursor = mintBuzzCursor(COMMUNITY, ROOM, { createdAt: 1_780_000_000, eventId: EVENT_ID });
    expect(readBuzzCursor(COMMUNITY, ROOM, cursor)).toEqual({
      createdAt: 1_780_000_000,
      eventId: EVENT_ID,
    });
  });

  it.each([
    ['another community', mintBuzzCursor('buzz-two' as CommunityRef, ROOM, pos())],
    ['another room', mintBuzzCursor(COMMUNITY, 'some-other-room', pos())],
    ['another kind of backend', 'local|buzz-one|room|1|4' as CommunityCursor],
    ['a token with too few fields', 'buzz|buzz-one|room|1' as CommunityCursor],
    ['a non-numeric second', `buzz|buzz-one|${ROOM}|later|${EVENT_ID}` as CommunityCursor],
    ['an event id that is not one', `buzz|buzz-one|${ROOM}|1|not-an-event-id` as CommunityCursor],
  ])('refuses %s rather than bounding it', (_case, cursor) => {
    expect(() => readBuzzCursor(COMMUNITY, ROOM, cursor)).toThrow(StaleCommunityCursorError);
  });

  it('round-trips the beginning-of-room sentinel it mints for an empty room', () => {
    // The regression behind conformance U17. A room with nothing in it still
    // has to hand its subscriber a cursor, and BEGINNING is the one it hands
    // out — so an encoding that only accepted real event ids minted a token and
    // then refused it, turning every resume of an empty room into a
    // StaleCommunityCursorError on a perfectly healthy room.
    const cursor = mintBuzzCursor(COMMUNITY, ROOM, BEGINNING);
    expect(readBuzzCursor(COMMUNITY, ROOM, cursor)).toEqual(BEGINNING);
    expect(isBeginning(readBuzzCursor(COMMUNITY, ROOM, cursor))).toBe(true);
  });

  it('accepts an empty event id ONLY at the beginning, never as a truncated token', () => {
    // The sentinel is a licence for one exact value, not for a shape. An empty
    // event id at a real second is a token that lost its tail, and reading it
    // as "the beginning of the room" would replay the whole history to a caller
    // who asked to resume near the end.
    expect(() =>
      readBuzzCursor(COMMUNITY, ROOM, `buzz|${COMMUNITY}|${ROOM}|1780000000|` as CommunityCursor)
    ).toThrow(StaleCommunityCursorError);
  });

  it('refuses to mint a cursor for a room id that would collide with its separator', () => {
    // A room id comes from the relay, not from us. One containing the field
    // separator would encode a token that reads back as a different position in
    // a different room — the exact misread the self-identifying rule exists to
    // prevent — so it is refused at mint rather than decoded wrongly later.
    expect(() => mintBuzzCursor(COMMUNITY, 'room|with|pipes', pos())).toThrow(/separator/);
  });

  it('orders by second, then by event id — never by second alone', () => {
    // The tiebreak is the whole reason a position is a pair. Without it two
    // events in the same second are unorderable, and a page boundary landing
    // between them drops one.
    const earlier = { createdAt: 100, eventId: 'a'.repeat(64) };
    const sameSecond = { createdAt: 100, eventId: 'b'.repeat(64) };
    const later = { createdAt: 101, eventId: 'a'.repeat(64) };

    expect(comparePositions(earlier, sameSecond)).toBeLessThan(0);
    expect(comparePositions(sameSecond, earlier)).toBeGreaterThan(0);
    expect(comparePositions(earlier, earlier)).toBe(0);
    expect(comparePositions(sameSecond, later)).toBeLessThan(0);
  });
});

/** A position, for the cases that only care that one exists. */
function pos(): { createdAt: number; eventId: string } {
  return { createdAt: 1_780_000_000, eventId: EVENT_ID };
}
