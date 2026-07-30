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
import { respondsTo, selectTriggerTargets, type AddressingMember } from '../addressing.js';

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
      entry: { authorId: 'ana', mentions: ['ana'] },
      members: [ana, bo],
    });
    expect(targets).not.toContain('ana');
  });

  it('never triggers a human or the system author', () => {
    const targets = selectTriggerTargets({
      roomKind: 'dm',
      entry: { authorId: 'ana', mentions: ['dorian', 'system'] },
      members: [ana, human, system],
    });
    expect(targets).toEqual([]);
  });

  it('triggers all three agents when all three were addressed', () => {
    const targets = selectTriggerTargets({
      roomKind: 'channel',
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
      entry: { authorId: 'dorian', mentions: [] },
      members: [ana, bo, human],
    });
    expect(targets).toEqual(['ana']);
  });

  it('returns targets in roster order, so the trigger order is stable', () => {
    const targets = selectTriggerTargets({
      roomKind: 'dm',
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
      entry: { authorId: 'dorian', mentions: [] },
      members: [inside, outside, human],
    });
    expect(targets).toEqual(['ana']);
  });
});
