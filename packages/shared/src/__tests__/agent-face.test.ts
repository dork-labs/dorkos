import { describe, it, expect } from 'vitest';
import {
  seedAgentFace,
  fnv1aHash,
  isSingleEmoji,
  AGENT_COLOR_PRESETS,
  AGENT_EMOJI_SET,
} from '../agent-face.js';

const ID = '01JQZ8V4K7YB3T0G5M2P9NXWQR';

describe('seedAgentFace', () => {
  it('seeds both halves when the caller chose nothing', () => {
    const face = seedAgentFace(ID);

    expect(AGENT_COLOR_PRESETS.map((preset) => preset.hex)).toContain(face.color);
    expect(AGENT_EMOJI_SET).toContain(face.icon);
  });

  it('keeps a chosen colour and a chosen emoji untouched', () => {
    const face = seedAgentFace(ID, { color: '#123456', icon: '🦕' });

    expect(face).toEqual({ color: '#123456', icon: '🦕' });
  });

  it('fills only the half the caller left out', () => {
    const seeded = seedAgentFace(ID);

    expect(seedAgentFace(ID, { icon: '🦕' })).toEqual({ color: seeded.color, icon: '🦕' });
    expect(seedAgentFace(ID, { color: '#123456' })).toEqual({
      color: '#123456',
      icon: seeded.icon,
    });
  });

  it('treats an absent choice and an explicitly undefined one the same', () => {
    expect(seedAgentFace(ID, { color: undefined, icon: undefined })).toEqual(seedAgentFace(ID));
  });

  it('gives the same id the same face every time', () => {
    expect(seedAgentFace(ID)).toEqual(seedAgentFace(ID));
  });

  it('gives different ids different faces', () => {
    // 200 draws rather than a handful, because a small sample cannot separate
    // the two implementations: at 24 ids an honest seed collides its way down
    // to 19 distinct faces and a single-salt one still reaches ~15, so any
    // bound between them is fitted to the sample rather than to the behaviour.
    // Over 200 ids the gap is structural — one salt can produce at most 30
    // distinct pairs no matter how many ids you feed it, because the colour
    // becomes a function of the emoji.
    const faces = new Set(
      Array.from({ length: 200 }, (_, i) => {
        const face = seedAgentFace(`${ID}${i}`);
        return `${face.color}${face.icon}`;
      })
    );

    // Measured: 90 distinct. The bound sits well above the 30 a single salt can
    // ever reach and well below the real spread, so it discriminates without
    // being pinned to one sample.
    expect(faces.size).toBeGreaterThan(60);
  });

  it('treats an empty string as no choice at all', () => {
    // `??` would take `''` as a chosen face and hand back a blank avatar that
    // no picker can explain.
    expect(seedAgentFace(ID, { color: '', icon: '' })).toEqual(seedAgentFace(ID));
  });

  it('does not tie the colour to the emoji', () => {
    // The emoji set is a whole multiple of the colour palette, so hashing both
    // from one salt would make every agent wearing a given emoji wear the same
    // colour with it. Two ids that land on the same emoji must be able to
    // differ in colour.
    const byIcon = new Map<string, Set<string>>();
    for (let i = 0; i < 400; i++) {
      const face = seedAgentFace(`agent-${i}`);
      const colors = byIcon.get(face.icon) ?? new Set<string>();
      colors.add(face.color);
      byIcon.set(face.icon, colors);
    }

    const sharedIcons = [...byIcon.values()].filter((colors) => colors.size > 1);
    expect(sharedIcons.length).toBeGreaterThan(0);
  });

  it('picks only from the curated sets', () => {
    const hexes = AGENT_COLOR_PRESETS.map((preset) => preset.hex);
    for (let i = 0; i < 200; i++) {
      const face = seedAgentFace(`agent-${i}`);
      expect(hexes).toContain(face.color);
      expect(AGENT_EMOJI_SET).toContain(face.icon);
    }
  });
});

describe('curated sets', () => {
  it('offers colours as hex, each named once', () => {
    for (const preset of AGENT_COLOR_PRESETS) {
      expect(preset.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(preset.name.length).toBeGreaterThan(0);
    }
    expect(new Set(AGENT_COLOR_PRESETS.map((p) => p.hex)).size).toBe(AGENT_COLOR_PRESETS.length);
  });

  it('offers each emoji once', () => {
    expect(new Set(AGENT_EMOJI_SET).size).toBe(AGENT_EMOJI_SET.length);
  });
});

describe('isSingleEmoji', () => {
  it('accepts a plain emoji and a variation-selector/ZWJ sequence', () => {
    expect(isSingleEmoji('🦊')).toBe(true);
    expect(isSingleEmoji('🛰️')).toBe(true);
    expect(isSingleEmoji('👨‍💻')).toBe(true);
  });

  it('refuses what a package may put in the same field instead', () => {
    // The marketplace schema allows "an emoji OR an icon identifier", so these
    // are the real inputs the install path has to turn down.
    expect(isSingleEmoji('package')).toBe(false);
    expect(isSingleEmoji('')).toBe(false);
    expect(isSingleEmoji('  ')).toBe(false);
    expect(isSingleEmoji('🦊 and more')).toBe(false);
  });
});

describe('fnv1aHash', () => {
  it('returns the FNV-1a offset basis for the empty string', () => {
    expect(fnv1aHash('')).toBe(0x811c9dc5);
  });

  it('returns an unsigned 32-bit integer', () => {
    const hash = fnv1aHash('any-agent-id');
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });

  it('is stable for one input and separates two', () => {
    expect(fnv1aHash('alpha')).toBe(fnv1aHash('alpha'));
    expect(fnv1aHash('alpha')).not.toBe(fnv1aHash('beta'));
  });
});
