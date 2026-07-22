import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@/layers/shared/model';
import {
  BEAT_ORDER,
  ONBOARDING_BEATS,
  buildScriptMessage,
  computeGrouping,
  getBeat,
} from '../model/onboarding-script';

function msg(id: string, role: 'user' | 'assistant'): ChatMessage {
  return buildScriptMessage(id, role, 'x');
}

describe('onboarding-script', () => {
  it('orders the beats arrival -> personality -> discovery -> handoff', () => {
    expect([...BEAT_ORDER]).toEqual(['arrival', 'personality', 'discovery', 'handoff']);
    expect(ONBOARDING_BEATS.map((b) => b.id)).toEqual([...BEAT_ORDER]);
  });

  it('gates the composer to the handoff beat only', () => {
    for (const beat of ONBOARDING_BEATS) {
      expect(beat.composerEnabled).toBe(beat.id === 'handoff');
    }
  });

  it('shows the personality widget on the personality beat and discovery on discovery', () => {
    expect(getBeat('personality').widget).toBe('personality');
    expect(getBeat('discovery').widget).toBe('discovery');
    expect(getBeat('arrival').widget).toBeUndefined();
    expect(getBeat('handoff').widget).toBeUndefined();
  });

  it('throws on an unknown beat id', () => {
    // @ts-expect-error probing runtime guard with an invalid id
    expect(() => getBeat('nope')).toThrow();
  });

  it('builds a renderable text message', () => {
    const m = buildScriptMessage('m1', 'assistant', 'Hello');
    expect(m).toMatchObject({
      id: 'm1',
      role: 'assistant',
      content: 'Hello',
      parts: [{ type: 'text', text: 'Hello' }],
    });
    expect(typeof m.timestamp).toBe('string');
  });

  describe('computeGrouping', () => {
    it('marks a lone message as "only"', () => {
      expect(computeGrouping([msg('a', 'assistant')])).toEqual([
        { position: 'only', groupIndex: 0 },
      ]);
    });

    it('groups consecutive same-role messages and splits on role change', () => {
      const grouping = computeGrouping([
        msg('a', 'assistant'),
        msg('b', 'assistant'),
        msg('c', 'user'),
      ]);
      expect(grouping).toEqual([
        { position: 'first', groupIndex: 0 },
        { position: 'last', groupIndex: 0 },
        { position: 'only', groupIndex: 1 },
      ]);
    });

    it('marks the middle of a three-message run', () => {
      const grouping = computeGrouping([
        msg('a', 'assistant'),
        msg('b', 'assistant'),
        msg('c', 'assistant'),
      ]);
      expect(grouping.map((g) => g.position)).toEqual(['first', 'middle', 'last']);
      expect(grouping.every((g) => g.groupIndex === 0)).toBe(true);
    });
  });
});
