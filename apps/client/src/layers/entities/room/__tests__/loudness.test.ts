import { describe, it, expect } from 'vitest';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { RoomKind, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { previewLoudness, roomLoudness } from '../lib/loudness';
import { RESPONSE_RUNGS, rungOf } from '../lib/response-mode';

/** One agent on a roster, at a stored response mode. */
function agent(displayName: string, responseMode: ResponseMode): RoomRosterEntry {
  return {
    roomId: 'room-1',
    authorId: `author-${displayName}`,
    responseMode,
    joinedAt: '2026-07-26T10:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq: 0,
    author: { id: `author-${displayName}`, kind: 'agent', displayName, handle: null },
    origin: 'local',
  };
}

/** The person reading. Never triggered by anything, in any room. */
function person(displayName: string, responseMode: ResponseMode = 'always'): RoomRosterEntry {
  return {
    ...agent(displayName, responseMode),
    author: { id: `author-${displayName}`, kind: 'human', displayName, handle: null },
  };
}

describe('roomLoudness', () => {
  it('counts the agents that keep talking, not every agent that can answer', () => {
    // Red if the count widens to include `@only`: it would read "Three agents
    // will answer you here" for a room where one of them answers exactly the
    // message that named it and nothing else.
    const loudness = roomLoudness(
      [agent('Mio', 'engaged'), agent('Cody', 'engaged'), agent('Kai', 'mention-only')],
      'channel'
    );

    expect(loudness.sentence).toBe('Two agents will answer you here');
    expect(loudness.level).toBe(3);
  });

  it('names the one agent the headline leaves out', () => {
    const loudness = roomLoudness(
      [agent('Mio', 'engaged'), agent('Cody', 'engaged'), agent('Kai', 'mention-only')],
      'channel'
    );

    expect(loudness.detail).toBe('Kai only when @mentioned');
  });

  it('names nobody once there are two left out, rather than picking one', () => {
    // Red if `detail` starts naming the first exception it finds: two
    // exceptions are a list, and a list of exceptions is the wall of peer
    // sentences the aggregate exists to replace.
    const loudness = roomLoudness(
      [agent('Mio', 'engaged'), agent('Kai', 'mention-only'), agent('Ravi', 'silent')],
      'channel'
    );

    expect(loudness.sentence).toBe('One agent will answer you here');
    expect(loudness.detail).toBeNull();
  });

  it('says so plainly when every answer is unconditional', () => {
    // Red if the loudest room in the product reads the same as a room of
    // `engaged` agents. Two agents answering EVERY message is the complaint
    // this panel gets opened for.
    const loudness = roomLoudness([agent('Mio', 'always'), agent('Cody', 'always')], 'channel');

    expect(loudness.sentence).toBe('Two agents answer every message here');
    expect(loudness.level).toBe(4);
  });

  it('drops back to the general sentence once one of them is only engaged', () => {
    // Red if "every message" is claimed on the strength of the loudest member
    // rather than of all of them — Cody does not answer every message.
    const loudness = roomLoudness([agent('Mio', 'always'), agent('Cody', 'engaged')], 'channel');

    expect(loudness.sentence).toBe('Two agents will answer you here');
    expect(loudness.level).toBe(4);
  });

  it('says only @mentions get an answer when nobody stays engaged', () => {
    const loudness = roomLoudness(
      [agent('Kai', 'mention-only'), agent('Ravi', 'silent')],
      'channel'
    );

    expect(loudness).toEqual({
      level: 2,
      sentence: 'Only @mentions get an answer here',
      detail: 'Ravi never speaks here',
    });
  });

  it('says nobody will answer when every agent is silent', () => {
    const loudness = roomLoudness([agent('Kai', 'silent'), agent('Ravi', 'silent')], 'channel');

    expect(loudness).toEqual({
      level: 1,
      sentence: 'Nobody here will answer you',
      detail: null,
    });
  });

  it('answers a room with no agents in it without counting to zero', () => {
    // Level 0 is not "quiet" — it is "there is no scale here". Red if an empty
    // room starts sharing the all-silent sentence, which would describe agents
    // that are not there.
    expect(roomLoudness([person('Dorian')], 'channel')).toEqual({
      level: 0,
      sentence: 'There is nobody here to answer you',
      detail: null,
    });
  });

  it('never counts the person reading, however loud their membership says they are', () => {
    // A human membership carries a `responseMode` — the schema gives every
    // membership one — and nothing in the server ever triggers on it. Red if
    // the filter goes: the room would report one more voice than it has, and
    // the extra one would be the reader.
    const withPerson = roomLoudness(
      [person('Dorian', 'always'), agent('Mio', 'engaged')],
      'channel'
    );
    const withoutPerson = roomLoudness([agent('Mio', 'engaged')], 'channel');

    expect(withPerson).toEqual(withoutPerson);
    expect(withPerson.sentence).toBe('One agent will answer you here');
  });

  describe('the room kind is part of the answer', () => {
    it('reads `direct-only` in a channel as @only', () => {
      // `direct-only` means "answers when addressed directly", and a channel is
      // not a direct message — `services/rooms/addressing.ts` degrades it to a
      // mention. Red if the room kind is dropped from the computation: this
      // roster would report an agent answering everything.
      const loudness = roomLoudness([agent('Kai', 'direct-only')], 'channel');

      expect(loudness.level).toBe(2);
      expect(loudness.sentence).toBe('Only @mentions get an answer here');
    });

    it('reads the same `direct-only` in a direct message as everything', () => {
      const loudness = roomLoudness([agent('Kai', 'direct-only')], 'dm');

      expect(loudness.level).toBe(4);
      expect(loudness.sentence).toBe('One agent answers every message here');
    });

    it('reads `engaged` the same in both kinds, because the window opens in both', () => {
      // It used to read as `@only` in a direct message, two bars instead of
      // three — a room aggregate that under-reported a room the reader was
      // looking at. `room-trigger.ts` has no channel gate on `engagementFor`.
      expect(roomLoudness([agent('Kai', 'engaged')], 'dm').level).toBe(3);
      expect(roomLoudness([agent('Kai', 'engaged')], 'channel').level).toBe(3);
    });
  });
});

describe('previewLoudness', () => {
  const ROSTER = [
    person('Dorian'),
    agent('Mio', 'engaged'),
    agent('Cody', 'engaged'),
    agent('Kai', 'mention-only'),
  ];

  it('shows the room one rung louder before the write goes out', () => {
    const preview = previewLoudness(ROSTER, 'channel', 'author-Kai', 'everything');

    expect(preview.level).toBe(4);
    expect(preview.sentence).toBe('Three agents will answer you here');
    expect(preview.detail).toBeNull();
  });

  it('shows the room quieter, and names whoever is left behind', () => {
    const preview = previewLoudness(ROSTER, 'channel', 'author-Cody', 'silent');

    expect(preview.sentence).toBe('One agent will answer you here');
    expect(preview.detail).toBeNull();
  });

  describe('is the same computation as the real one', () => {
    // The drift this guards is the whole reason the two share a body: a preview
    // that disagrees with the outcome teaches the wrong model, and only proves
    // itself wrong after the write has landed. Red the moment either grows a
    // branch the other does not have.
    const KINDS: RoomKind[] = ['channel', 'dm'];

    for (const kind of KINDS) {
      for (const option of RESPONSE_RUNGS) {
        it(`agrees with roomLoudness when nothing moves — ${kind}, ${option.label}`, () => {
          const roster = [person('Dorian'), agent('Mio', 'engaged'), agent('Kai', 'mention-only')];
          // Put Mio exactly where it already is, expressed as a rung. Nothing
          // about the room changes, so neither may the answer.
          const standing = rungOf(roster[1]!.responseMode, kind);
          const preview = previewLoudness(roster, kind, 'author-Mio', standing);

          expect(preview).toEqual(roomLoudness(roster, kind));
          // The second half of the sweep: every rung the room offers produces
          // an answer at all, so a rung with no branch behind it cannot hide.
          expect(previewLoudness(roster, kind, 'author-Mio', option.rung).sentence).toBeTruthy();
        });
      }
    }
  });

  it('previews the engaged rung as itself in a direct message', () => {
    // It used to answer with the `@only` room instead, because a DM wrote
    // `mention-only` for this rung — so the line at the top of the sheet
    // promised a quieter room than the write would produce, and then the write
    // produced that quieter room and the preview looked right. Red if the two
    // ever agree again: `engaged` lights three bars and `@only` two.
    const roster = [person('Dorian'), agent('Kai', 'silent')];

    expect(previewLoudness(roster, 'dm', 'author-Kai', 'engaged')).not.toEqual(
      previewLoudness(roster, 'dm', 'author-Kai', 'mention')
    );
    expect(previewLoudness(roster, 'dm', 'author-Kai', 'engaged').level).toBe(3);
  });

  it('changes nothing for an author who is not on the roster', () => {
    expect(previewLoudness(ROSTER, 'channel', 'author-nobody', 'everything')).toEqual(
      roomLoudness(ROSTER, 'channel')
    );
  });

  it('changes nothing when the author named is the person reading', () => {
    // People have no rung. Red if the human filter moves below the override,
    // which would let a preview hand the reader a loudness they cannot have.
    expect(previewLoudness(ROSTER, 'channel', 'author-Dorian', 'everything')).toEqual(
      roomLoudness(ROSTER, 'channel')
    );
  });
});
