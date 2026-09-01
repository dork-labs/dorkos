import { describe, it, expect } from 'vitest';
import { seedAgentFace, fnv1aHash, AGENT_COLOR_PRESETS, AGENT_EMOJI_SET } from '../agent-face.js';

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
    const faces = new Set(
      Array.from({ length: 24 }, (_, i) => {
        const face = seedAgentFace(`${ID}${i}`);
        return `${face.color}${face.icon}`;
      })
    );

    // 300 possible faces, 24 draws: a single-hash implementation would collapse
    // this to at most 30 and the pigeonholing would show up long before here.
    expect(faces.size).toBeGreaterThan(15);
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
