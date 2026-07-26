/**
 * The full addressing matrix from spec `rooms` §5: every `responseMode` in
 * every room kind, mentioned and not. This is the whole rule, so the whole
 * rule is enumerated rather than sampled.
 */
import { describe, it, expect } from 'vitest';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { RoomKind } from '@dorkos/shared/room-schemas';
import { respondsTo, selectTriggerTargets, type AddressingMember } from '../addressing.js';

const MODES: ResponseMode[] = ['always', 'direct-only', 'mention-only', 'silent'];
const KINDS: RoomKind[] = ['channel', 'dm', 'thread'];

/**
 * The expected answer for every (mode, kind, mentioned) triple, written out
 * independently of the implementation so a change to one has to be a deliberate
 * change to the other.
 */
const EXPECTED: Record<ResponseMode, Record<RoomKind, { plain: boolean; mentioned: boolean }>> = {
  always: {
    channel: { plain: true, mentioned: true },
    dm: { plain: true, mentioned: true },
    thread: { plain: true, mentioned: true },
  },
  'direct-only': {
    channel: { plain: false, mentioned: true },
    dm: { plain: true, mentioned: true },
    thread: { plain: false, mentioned: true },
  },
  'mention-only': {
    channel: { plain: false, mentioned: true },
    dm: { plain: false, mentioned: true },
    thread: { plain: false, mentioned: true },
  },
  silent: {
    channel: { plain: false, mentioned: false },
    dm: { plain: false, mentioned: false },
    thread: { plain: false, mentioned: false },
  },
};

describe('respondsTo — the full responseMode x roomKind matrix', () => {
  for (const mode of MODES) {
    for (const roomKind of KINDS) {
      const expected = EXPECTED[mode][roomKind];

      it(`${mode} in a ${roomKind}, not mentioned -> ${expected.plain}`, () => {
        expect(respondsTo(mode, { roomKind, mentioned: false })).toBe(expected.plain);
      });

      it(`${mode} in a ${roomKind}, mentioned -> ${expected.mentioned}`, () => {
        expect(respondsTo(mode, { roomKind, mentioned: true })).toBe(expected.mentioned);
      });
    }
  }
});

describe('selectTriggerTargets', () => {
  const ana: AddressingMember = { authorId: 'ana', kind: 'agent', responseMode: 'always' };
  const bo: AddressingMember = { authorId: 'bo', kind: 'agent', responseMode: 'mention-only' };
  const human: AddressingMember = { authorId: 'dorian', kind: 'human', responseMode: 'always' };
  const system: AddressingMember = { authorId: 'system', kind: 'system', responseMode: 'always' };

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
      members: [ana, bo, { authorId: 'cy', kind: 'agent', responseMode: 'direct-only' }, human],
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
      members: [bo, ana, { authorId: 'cy', kind: 'agent', responseMode: 'direct-only' }],
    });
    expect(targets).toEqual(['ana', 'cy']);
  });
});
