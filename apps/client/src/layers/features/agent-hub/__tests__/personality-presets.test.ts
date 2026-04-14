import { describe, it, expect } from 'vitest';
import { PERSONALITY_PRESETS, findMatchingPreset } from '../model/personality-presets';

describe('personality-presets', () => {
  it('contains exactly 8 presets', () => {
    expect(PERSONALITY_PRESETS).toHaveLength(8);
  });

  it('each preset has all required fields', () => {
    for (const preset of PERSONALITY_PRESETS) {
      expect(preset.id).toBeTruthy();
      expect(preset.name).toBeTruthy();
      expect(preset.emoji).toBeTruthy();
      expect(preset.tagline).toBeTruthy();
      expect(preset.sampleResponse).toBeTruthy();
      expect(preset.traits).toBeDefined();
      expect(Object.keys(preset.traits)).toEqual([
        'verbosity',
        'autonomy',
        'chaos',
        'creativity',
        'humor',
        'spice',
      ]);
      expect(preset.colors).toBeDefined();
      expect(Object.keys(preset.colors)).toEqual([
        'nebula',
        'wisp',
        'stroke',
        'strokeEnd',
        'fill',
        'fillEnd',
        'glow',
        'dot',
      ]);
    }
  });

  it('all trait values are between 1 and 5', () => {
    for (const preset of PERSONALITY_PRESETS) {
      for (const [, value] of Object.entries(preset.traits)) {
        expect(value).toBeGreaterThanOrEqual(1);
        expect(value).toBeLessThanOrEqual(5);
      }
    }
  });

  it('each preset has a unique id', () => {
    const ids = PERSONALITY_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe('findMatchingPreset', () => {
    it('returns the Balanced preset for default traits', () => {
      const result = findMatchingPreset({
        verbosity: 3,
        autonomy: 3,
        chaos: 3,
        creativity: 3,
        humor: 3,
        spice: 3,
      });
      expect(result?.id).toBe('balanced');
    });

    it('returns The Hotshot for matching traits', () => {
      const result = findMatchingPreset({
        verbosity: 2,
        autonomy: 5,
        chaos: 4,
        creativity: 5,
        humor: 3,
        spice: 4,
      });
      expect(result?.id).toBe('hotshot');
    });

    it('returns undefined for custom traits that match no preset', () => {
      const result = findMatchingPreset({
        verbosity: 1,
        autonomy: 1,
        chaos: 1,
        creativity: 1,
        humor: 1,
        spice: 1,
      });
      expect(result).toBeUndefined();
    });
  });
});
