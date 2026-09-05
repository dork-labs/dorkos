import { describe, it, expect } from 'vitest';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { RoomKind } from '@dorkos/shared/room-schemas';
import {
  RESPONSE_RUNGS,
  explainRung,
  modeForRung,
  rungOf,
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

describe('RESPONSE_RUNGS', () => {
  it('is four rungs, quietest first', () => {
    // The order IS the information. A reader who cannot rank five sentences can
    // read a left-to-right scale without being told how, so the sequence is
    // pinned rather than the set.
    expect(RESPONSE_RUNGS.map((option) => option.label)).toEqual([
      'Silent',
      '@only',
      'Engaged',
      'Everything',
    ]);
  });
});

describe('rungOf', () => {
  it.each(BOTH_KINDS)('lands every stored value on a rung a %s really offers', (roomKind) => {
    // The API accepts all five in every room and the schema calls them legal,
    // so a membership CAN hold one this room would never offer — set by a
    // script, an older build, or an agent through the operator surface. A
    // control that blanked for it would be a setting nobody can fix.
    const offered = RESPONSE_RUNGS.map((option) => option.rung);

    for (const mode of EVERY_STORED_MODE) {
      expect(offered).toContain(rungOf(mode, roomKind));
    }
  });

  it('reads the one value whose behaviour depends on the room', () => {
    // Straight off the table in `services/rooms/addressing.ts`: `direct-only`
    // answers everything in a DM and only mentions in a channel. It is the one
    // of the five that no single label could ever have covered honestly.
    expect(rungOf('direct-only', 'channel')).toBe('mention');
    expect(rungOf('direct-only', 'dm')).toBe('everything');
  });

  it('reads the four that mean the same thing wherever they are stored', () => {
    for (const roomKind of BOTH_KINDS) {
      expect(rungOf('silent', roomKind)).toBe('silent');
      expect(rungOf('mention-only', roomKind)).toBe('mention');
      // Including `engaged`, which is the fix: the window opens in a direct
      // message exactly as it does in a channel — `room-trigger.ts` has no
      // channel gate — so collapsing it onto `@only` here described a
      // behaviour the server does not have.
      expect(rungOf('engaged', roomKind)).toBe('engaged');
      expect(rungOf('always', roomKind)).toBe('everything');
    }
  });
});

describe('modeForRung', () => {
  it.each(BOTH_KINDS)('writes a value that reads back as the rung picked, in a %s', (roomKind) => {
    // The round trip is the whole contract: pick a rung, store a mode, reopen
    // the panel, and the control must be where you left it.
    for (const { rung } of RESPONSE_RUNGS) {
      expect(rungOf(modeForRung(rung), roomKind)).toBe(rung);
    }
  });

  it('never writes the one alias whose meaning moves', () => {
    // `direct-only` means something different in each kind of room, so nothing
    // this panel writes should ever be one — a membership carrying it would
    // change behaviour if the room it was in ever changed kind.
    expect(RESPONSE_RUNGS.map(({ rung }) => modeForRung(rung))).not.toContain('direct-only');
  });

  it('writes `engaged` for the engaged rung, in a direct message too', () => {
    // The rung a direct message could not reach. `mention-only` was written
    // here instead, so picking `Engaged` in a DM silently narrowed the
    // membership — and `respondsTo` proves the two are different behaviours:
    // an engaged member nobody mentioned answers, a mention-only one does not.
    expect(modeForRung('engaged')).toBe('engaged');
  });
});

describe('explainRung', () => {
  it.each(BOTH_KINDS)('says something different for every rung of a %s', (roomKind) => {
    // Two rungs that read the same are a control with nothing to choose — the
    // exact defect the five peer sentences had.
    const sentences = RESPONSE_RUNGS.map(
      ({ rung }) => explainRung(rung, roomKind, WINDOW).sentence
    );

    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it.each(BOTH_KINDS)(
    'quotes the window this install is running in a %s, not the one it ships with',
    (roomKind) => {
      // The numbers are settings. An install that tuned them and then read the
      // shipped 10 and 5 would be reading about somebody else's machine.
      //
      // Both kinds, because a direct message used to be answered here with the
      // `@only` sentence instead — a description that was false of the
      // membership it was describing.
      const { sentence } = explainRung('engaged', roomKind, WINDOW);

      expect(sentence).toBe(
        'Answers when you @mention it, then keeps answering for 3 more minutes or ' +
          '7 more messages, whichever runs out first.'
      );
    }
  );

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

  it('tells a direct message’s engaged rung apart from its @only one', () => {
    // The defect this replaces: `engaged` in a DM was described with the
    // `@only` sentence, so a membership really holding `engaged` was shown a
    // description of a behaviour it does not have. Red if the two ever say the
    // same thing again — that is a control with nothing to choose.
    expect(explainRung('engaged', 'dm', WINDOW).sentence).not.toBe(
      explainRung('mention', 'dm', WINDOW).sentence
    );
    expect(explainRung('engaged', 'dm', WINDOW).sentence).toContain('keeps answering');
  });
});
