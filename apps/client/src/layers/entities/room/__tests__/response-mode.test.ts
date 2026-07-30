import { describe, it, expect } from 'vitest';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { RoomKind } from '@dorkos/shared/room-schemas';
import {
  explainRung,
  modeForRung,
  rungOf,
  rungsFor,
  type EngagedWindow,
} from '../lib/response-mode';

/** Every value the schema calls legal, whatever a room would offer today. */
const EVERY_STORED_MODE: readonly ResponseMode[] = [
  'always',
  'engaged',
  'direct-only',
  'mention-only',
  'silent',
];

const BOTH_KINDS: readonly RoomKind[] = ['channel', 'dm'];

/** A window with numbers nobody ships, so a hardcoded 10/5 cannot pass for it. */
const WINDOW: EngagedWindow = { engagedWindowMinutes: 3, engagedWindowPosts: 7 };

describe('rungsFor', () => {
  it('gives a channel four rungs, quietest first', () => {
    // The order IS the information. A reader who cannot rank five sentences can
    // read a left-to-right scale without being told how, so the sequence is
    // pinned rather than the set.
    expect(rungsFor('channel').map((option) => option.label)).toEqual([
      'Silent',
      '@only',
      'Engaged',
      'Everything',
    ]);
  });

  it('gives a direct message three, because it only has three behaviours', () => {
    // `engaged` has no window to be in here: the window only opens on an
    // @mention and nobody @s anyone in a two-person conversation. Offering it
    // would be a fourth option that produces a third behaviour.
    expect(rungsFor('dm').map((option) => option.label)).toEqual(['Silent', '@only', 'Everything']);
  });
});

describe('rungOf', () => {
  it.each(BOTH_KINDS)('lands every stored value on a rung a %s really offers', (roomKind) => {
    // The API accepts all five in every room and the schema calls them legal,
    // so a membership CAN hold one this room would never offer — set by a
    // script, an older build, or an agent through the operator surface. A
    // control that blanked for it would be a setting nobody can fix.
    const offered = rungsFor(roomKind).map((option) => option.rung);

    for (const mode of EVERY_STORED_MODE) {
      expect(offered).toContain(rungOf(mode, roomKind));
    }
  });

  it('reads the two values whose behaviour depends on the room', () => {
    // Straight off the table in `services/rooms/addressing.ts`: `direct-only`
    // answers everything in a DM and only mentions in a channel, and `engaged`
    // has a window in a channel and none in a DM. These are the two that no
    // single label could ever have covered honestly.
    expect(rungOf('direct-only', 'channel')).toBe('mention');
    expect(rungOf('direct-only', 'dm')).toBe('everything');
    expect(rungOf('engaged', 'channel')).toBe('engaged');
    expect(rungOf('engaged', 'dm')).toBe('mention');
  });

  it('reads the three that mean the same thing wherever they are stored', () => {
    for (const roomKind of BOTH_KINDS) {
      expect(rungOf('silent', roomKind)).toBe('silent');
      expect(rungOf('mention-only', roomKind)).toBe('mention');
      expect(rungOf('always', roomKind)).toBe('everything');
    }
  });
});

describe('modeForRung', () => {
  it.each(BOTH_KINDS)('writes a value that reads back as the rung picked, in a %s', (roomKind) => {
    // The round trip is the whole contract: pick a rung, store a mode, reopen
    // the panel, and the control must be where you left it.
    for (const { rung } of rungsFor(roomKind)) {
      expect(rungOf(modeForRung(rung, roomKind), roomKind)).toBe(rung);
    }
  });

  it('never writes one of the two aliases whose meaning moves', () => {
    // `direct-only` means something different in each kind of room, so nothing
    // this panel writes should ever be one — a membership carrying it would
    // change behaviour if the room it was in ever changed kind.
    const written = BOTH_KINDS.flatMap((roomKind) =>
      rungsFor(roomKind).map(({ rung }) => modeForRung(rung, roomKind))
    );

    expect(written).not.toContain('direct-only');
    expect(written.filter((mode) => mode === 'engaged')).toEqual(['engaged']);
  });

  it('stores what a direct message would actually do when asked for engaged', () => {
    // Not offered there, but total: `engaged` in a DM behaves as @only, so
    // writing `mention-only` is the value that keeps the control still.
    expect(modeForRung('engaged', 'dm')).toBe('mention-only');
    expect(rungOf(modeForRung('engaged', 'dm'), 'dm')).toBe('mention');
  });
});

describe('explainRung', () => {
  it.each(BOTH_KINDS)('says something different for every rung of a %s', (roomKind) => {
    // Two rungs that read the same are a control with nothing to choose — the
    // exact defect the five peer sentences had.
    const sentences = rungsFor(roomKind).map(
      ({ rung }) => explainRung(rung, roomKind, WINDOW).sentence
    );

    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('quotes the window this install is running, not the one it ships with', () => {
    // The numbers are settings. An install that tuned them and then read the
    // shipped 10 and 5 would be reading about somebody else's machine.
    const { sentence } = explainRung('engaged', 'channel', WINDOW);

    expect(sentence).toBe(
      'Answers when you @mention it — then keeps answering for 3 more minutes or ' +
        '7 more messages, whichever runs out first.'
    );
  });

  it('agrees its units with its numbers', () => {
    const { sentence } = explainRung('engaged', 'channel', {
      engagedWindowMinutes: 1,
      engagedWindowPosts: 1,
    });

    expect(sentence).toContain('1 more minute or 1 more message,');
  });

  it('invents no numbers while the window is still being read', () => {
    const { sentence } = explainRung('engaged', 'channel', null);

    expect(sentence).not.toMatch(/\d/);
    expect(sentence).toContain('@mention');
  });

  it('does not promise a window an operator has switched off', () => {
    // Either ceiling at zero means the window can never be open. "Keeps
    // answering for 0 more minutes" is a sentence that describes nothing.
    for (const off of [
      { engagedWindowMinutes: 0, engagedWindowPosts: 5 },
      { engagedWindowMinutes: 10, engagedWindowPosts: 0 },
    ]) {
      const { sentence, note } = explainRung('engaged', 'channel', off);

      expect(sentence).not.toContain('keeps answering');
      expect(note).toContain('switched off');
    }
  });

  it('tells a silent agent apart from an absent one', () => {
    const { sentence, note } = explainRung('silent', 'channel', WINDOW);

    expect(sentence).toBe('Never speaks here');
    // The reassurance is the point: silencing an agent in one room is not
    // switching the agent off.
    expect(note).toBe('You can still talk to it in its own session.');
  });

  it('says who the loudest rung is answering, which differs by room', () => {
    expect(explainRung('everything', 'dm', WINDOW).sentence).toBe(
      'Answers every message you send here.'
    );
    expect(explainRung('everything', 'channel', WINDOW).sentence).toBe(
      'Answers every message in this room.'
    );
  });

  it('describes a direct message’s stored engaged value as what it does', () => {
    // Total function: a DM has no engaged rung, and a caller reaching one is
    // asking about a stored value that behaves as @only there.
    expect(explainRung('engaged', 'dm', WINDOW)).toEqual(explainRung('mention', 'dm', WINDOW));
  });
});
