/**
 * The full addressing matrix from spec `rooms` §5: every `responseMode` in
 * every room kind, mentioned and not, engaged and not. This is the whole rule,
 * so the whole rule is enumerated rather than sampled.
 *
 * Two kinds, not three. A thread is a position inside a channel rather than a
 * room (ADR 260728-022013), so a reply there is addressed by the channel's row.
 *
 * The `isEngaged` axis is `engagement.ts`'s predicate, already evaluated. Only
 * `engaged` may read it, and the matrix says so by carrying the same answer in
 * both columns for every other mode: a mode that started reading the flag would
 * turn four of these rows red.
 */
import { describe, it, expect } from 'vitest';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { RoomKind } from '@dorkos/shared/room-schemas';
import {
  respondsTo,
  selectTriggerTargets,
  standDownFallbackSeat,
  type AddressingMember,
} from '../addressing.js';

const MODES: ResponseMode[] = ['always', 'engaged', 'direct-only', 'mention-only', 'silent'];
const KINDS: RoomKind[] = ['channel', 'dm'];

/** The four (mentioned, isEngaged) corners, for one mode in one room kind. */
interface Corners {
  plain: boolean;
  mentioned: boolean;
  engaged: boolean;
  both: boolean;
}

/**
 * The expected answer for every (mode, kind, mentioned, isEngaged) tuple,
 * written out independently of the implementation so a change to one has to be a
 * deliberate change to the other.
 */
const EXPECTED: Record<ResponseMode, Record<RoomKind, Corners>> = {
  always: {
    channel: { plain: true, mentioned: true, engaged: true, both: true },
    dm: { plain: true, mentioned: true, engaged: true, both: true },
  },
  // The only mode that reads the flag, and it reads it in both room kinds: a
  // direct message is a conversation you can be mid-way through too.
  engaged: {
    channel: { plain: false, mentioned: true, engaged: true, both: true },
    dm: { plain: false, mentioned: true, engaged: true, both: true },
  },
  'direct-only': {
    channel: { plain: false, mentioned: true, engaged: false, both: true },
    dm: { plain: true, mentioned: true, engaged: true, both: true },
  },
  'mention-only': {
    channel: { plain: false, mentioned: true, engaged: false, both: true },
    dm: { plain: false, mentioned: true, engaged: false, both: true },
  },
  silent: {
    channel: { plain: false, mentioned: false, engaged: false, both: false },
    dm: { plain: false, mentioned: false, engaged: false, both: false },
  },
};

describe('respondsTo — the full responseMode x roomKind x engagement matrix', () => {
  for (const mode of MODES) {
    for (const roomKind of KINDS) {
      const expected = EXPECTED[mode][roomKind];

      it(`${mode} in a ${roomKind}, not mentioned, not engaged -> ${expected.plain}`, () => {
        expect(respondsTo(mode, { roomKind, mentioned: false, isEngaged: false })).toBe(
          expected.plain
        );
      });

      it(`${mode} in a ${roomKind}, mentioned -> ${expected.mentioned}`, () => {
        expect(respondsTo(mode, { roomKind, mentioned: true, isEngaged: false })).toBe(
          expected.mentioned
        );
      });

      it(`${mode} in a ${roomKind}, engaged -> ${expected.engaged}`, () => {
        expect(respondsTo(mode, { roomKind, mentioned: false, isEngaged: true })).toBe(
          expected.engaged
        );
      });

      it(`${mode} in a ${roomKind}, mentioned and engaged -> ${expected.both}`, () => {
        expect(respondsTo(mode, { roomKind, mentioned: true, isEngaged: true })).toBe(
          expected.both
        );
      });
    }
  }
});

describe('selectTriggerTargets', () => {
  const ana: AddressingMember = {
    authorId: 'ana',
    kind: 'agent',
    responseMode: 'always',
    isEngaged: false,
  };
  const bo: AddressingMember = {
    authorId: 'bo',
    kind: 'agent',
    responseMode: 'mention-only',
    isEngaged: false,
  };
  const human: AddressingMember = {
    authorId: 'dorian',
    kind: 'human',
    responseMode: 'always',
    isEngaged: false,
  };
  const system: AddressingMember = {
    authorId: 'system',
    kind: 'system',
    responseMode: 'always',
    isEngaged: false,
  };

  it('never triggers the entry author, however eager their mode', () => {
    const targets = selectTriggerTargets({
      roomKind: 'channel',
      authorKind: 'agent',
      entry: { authorId: 'ana', mentions: ['ana'] },
      members: [ana, bo],
    });
    expect(targets).not.toContain('ana');
  });

  it('never triggers a human or the system author', () => {
    const targets = selectTriggerTargets({
      roomKind: 'dm',
      authorKind: 'agent',
      entry: { authorId: 'ana', mentions: ['dorian', 'system'] },
      members: [ana, human, system],
    });
    expect(targets).toEqual([]);
  });

  it('triggers all three agents when all three were addressed', () => {
    const targets = selectTriggerTargets({
      roomKind: 'channel',
      authorKind: 'human',
      entry: { authorId: 'dorian', mentions: ['ana', 'bo', 'cy'] },
      members: [
        ana,
        bo,
        { authorId: 'cy', kind: 'agent', responseMode: 'direct-only', isEngaged: false },
        human,
      ],
    });
    // Three answers to one question is the intended outcome, not a pathology.
    expect(targets).toEqual(['ana', 'bo', 'cy']);
  });

  it('leaves a mention-only agent alone in a busy channel', () => {
    const targets = selectTriggerTargets({
      roomKind: 'channel',
      authorKind: 'human',
      entry: { authorId: 'dorian', mentions: [] },
      members: [ana, bo, human],
    });
    expect(targets).toEqual(['ana']);
  });

  it('returns targets in roster order, so the trigger order is stable', () => {
    const targets = selectTriggerTargets({
      roomKind: 'dm',
      authorKind: 'human',
      entry: { authorId: 'dorian', mentions: [] },
      members: [
        bo,
        ana,
        { authorId: 'cy', kind: 'agent', responseMode: 'direct-only', isEngaged: false },
      ],
    });
    expect(targets).toEqual(['ana', 'cy']);
  });

  it('triggers an engaged agent nobody named, and leaves the one whose window closed', () => {
    const inside: AddressingMember = {
      authorId: 'ana',
      kind: 'agent',
      responseMode: 'engaged',
      isEngaged: true,
    };
    const outside: AddressingMember = {
      authorId: 'bo',
      kind: 'agent',
      responseMode: 'engaged',
      isEngaged: false,
    };
    const targets = selectTriggerTargets({
      roomKind: 'channel',
      authorKind: 'human',
      entry: { authorId: 'dorian', mentions: [] },
      members: [inside, outside, human],
    });
    expect(targets).toEqual(['ana']);
  });
});

/**
 * The second rule, applied only by a room that hands one member the fallback
 * seat. `selectTriggerTargets` above is untouched by every case here — the
 * matrix is the generic contract and this filter runs after it.
 */
describe('standDownFallbackSeat', () => {
  /** The default agent: the `always` seat that catches unaddressed posts. */
  const seat: AddressingMember = {
    authorId: 'dorkbot',
    kind: 'agent',
    responseMode: 'always',
    isEngaged: false,
  };
  /** An ordinary teammate on the channel default. */
  const nova: AddressingMember = {
    authorId: 'nova',
    kind: 'agent',
    responseMode: 'engaged',
    isEngaged: false,
  };
  const ace: AddressingMember = { ...nova, authorId: 'ace' };
  const human: AddressingMember = {
    authorId: 'dorian',
    kind: 'human',
    responseMode: 'always',
    isEngaged: false,
  };

  /** Run the rule over a post by the PERSON, on a fixed roster. */
  function stand(mentions: string[], selected: string[], members = [seat, nova, ace, human]) {
    return standDownFallbackSeat({
      entry: { authorId: 'dorian', mentions },
      authorKind: 'human',
      seatAuthorId: 'dorkbot',
      members,
      selected,
    });
  }

  /** The same, for a post written by an AGENT — a reply, or an update. */
  function agentSaid(
    authorId: string,
    mentions: string[],
    selected: string[],
    members = [seat, nova, ace, human]
  ) {
    return standDownFallbackSeat({
      entry: { authorId, mentions },
      authorKind: 'agent',
      seatAuthorId: 'dorkbot',
      members,
      selected,
    });
  }

  it('leaves an unaddressed post alone — the seat is what answers it', () => {
    expect(stand([], ['dorkbot'])).toEqual(['dorkbot']);
  });

  it('drops the seat when the post named another agent', () => {
    expect(stand(['nova'], ['dorkbot', 'nova'])).toEqual(['nova']);
  });

  it('drops it once for a post that named two others', () => {
    expect(stand(['nova', 'ace'], ['dorkbot', 'nova', 'ace'])).toEqual(['nova', 'ace']);
  });

  it('keeps the seat when the post named it too', () => {
    expect(stand(['nova', 'dorkbot'], ['dorkbot', 'nova'])).toEqual(['dorkbot', 'nova']);
  });

  it('keeps the seat when it is inside its own engaged window', () => {
    // Somebody addressed it by name recently — `engagement.ts` anchors on a
    // mention — so it is in the conversation as itself, not as the fallback,
    // and handing one task to Nova does not dismiss it.
    const engagedSeat = { ...seat, isEngaged: true };
    expect(stand(['nova'], ['dorkbot', 'nova'], [engagedSeat, nova, ace, human])).toEqual([
      'dorkbot',
      'nova',
    ]);
  });

  it('leaves a post that named only a PERSON alone', () => {
    // Naming a person is not delegating the question to an agent.
    expect(stand(['dorian'], ['dorkbot'])).toEqual(['dorkbot']);
  });

  it('leaves a post whose names reached nobody alone', () => {
    // `@ghost` resolved to no member, so nothing was addressed and the seat is
    // the only thing standing between the question and silence.
    expect(stand([], ['dorkbot'])).toEqual(['dorkbot']);
  });

  it('never touches a member that is not the seat', () => {
    // An `engaged` agent selected because IT was mentioned is not a fallback.
    expect(stand(['nova', 'ace'], ['nova', 'ace'])).toEqual(['nova', 'ace']);
  });

  it('empties the set when the post named only an agent that will not answer', () => {
    // Nova is silent, so she is not in `selected`; the seat still stands down,
    // because the message was addressed and not to it.
    const silentNova: AddressingMember = { ...nova, responseMode: 'silent' };
    expect(stand(['nova'], ['dorkbot'], [seat, silentNova, human])).toEqual([]);
  });

  it('ignores a mention of the entry author, who is never a target anyway', () => {
    const byNova = standDownFallbackSeat({
      entry: { authorId: 'nova', mentions: ['nova'] },
      authorKind: 'agent',
      seatAuthorId: 'dorkbot',
      members: [seat, nova, human],
      selected: ['dorkbot'],
    });
    // Nova wrote it, so the seat stands down on the agent-authored rule — the
    // self-mention is not what decided it.
    expect(byNova).toEqual([]);
  });

  describe('a post written by an agent', () => {
    it('does not reach the seat, even with nobody named', () => {
      // The leak the mention rule alone leaves open: Nova stands up for
      // `@nova ...`, answers, and her reply is an unaddressed post that `always`
      // would catch one cascade hop later — so the operator gets the pile-on
      // they were told was gone.
      expect(agentSaid('nova', [], ['dorkbot'])).toEqual([]);
    });

    it('reaches the seat when the reply named it', () => {
      expect(agentSaid('nova', ['dorkbot'], ['dorkbot'])).toEqual(['dorkbot']);
    });

    it('reaches a seat that is inside its own engaged window', () => {
      // You are mid-conversation with it, so a colleague's reply is part of the
      // conversation it is already in.
      const engagedSeat = { ...seat, isEngaged: true };
      expect(agentSaid('nova', [], ['dorkbot'], [engagedSeat, nova, ace, human])).toEqual([
        'dorkbot',
      ]);
    });

    it('leaves every other agent the reply reaches alone', () => {
      expect(agentSaid('nova', ['ace'], ['dorkbot', 'ace'])).toEqual(['ace']);
    });
  });

  describe('the seat is named, not inferred from the mode', () => {
    /** Nova, set to "Everything" by the person from the room's member menu. */
    const novaAlways: AddressingMember = { ...nova, responseMode: 'always' };

    it("leaves a person's own always member answering when somebody else is named", () => {
      const targets = standDownFallbackSeat({
        entry: { authorId: 'dorian', mentions: ['ace'] },
        authorKind: 'human',
        seatAuthorId: 'dorkbot',
        members: [seat, novaAlways, ace, human],
        selected: ['dorkbot', 'nova', 'ace'],
      });
      // The seat steps back; Nova does not, because `always` still means always
      // for a membership the person set themselves.
      expect(targets).toEqual(['nova', 'ace']);
    });

    it("leaves a person's own always member answering an agent's reply", () => {
      expect(agentSaid('ace', [], ['dorkbot', 'nova'], [seat, novaAlways, ace, human])).toEqual([
        'nova',
      ]);
    });

    it('does nothing at all in a room with no seat', () => {
      const targets = standDownFallbackSeat({
        entry: { authorId: 'dorian', mentions: ['ace'] },
        authorKind: 'human',
        seatAuthorId: null,
        members: [seat, novaAlways, ace, human],
        selected: ['dorkbot', 'nova', 'ace'],
      });
      expect(targets).toEqual(['dorkbot', 'nova', 'ace']);
    });

    it('does nothing when the seat was not selected in the first place', () => {
      const silentSeat: AddressingMember = { ...seat, responseMode: 'silent' };
      expect(stand(['ace'], ['ace'], [silentSeat, nova, ace, human])).toEqual(['ace']);
    });
  });
});
